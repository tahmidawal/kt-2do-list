"""Geocoding, travel time, and weather lookups.

All three providers are free and keyless:
  - Nominatim (OpenStreetMap) for address -> lat/lon
  - OSRM public demo server for driving time (falls back to a straight-line estimate)
  - Open-Meteo for the forecast
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any

import httpx

USER_AGENT = "kt-2do-list/1.0 (personal date planner)"
TIMEOUT = httpx.Timeout(15.0)

WEATHER_CODES = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "freezing fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    56: "freezing drizzle",
    57: "heavy freezing drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "freezing rain",
    67: "heavy freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "light rain showers",
    81: "rain showers",
    82: "violent rain showers",
    85: "light snow showers",
    86: "heavy snow showers",
    95: "thunderstorm",
    96: "thunderstorm with hail",
    99: "thunderstorm with heavy hail",
}


class GeoError(Exception):
    """Raised when we cannot make sense of a place the user typed."""


async def geocode(query: str) -> dict[str, Any]:
    """Turn a free-text place into coordinates. Raises GeoError if not found."""
    query = (query or "").strip()
    if not query:
        raise GeoError("Please enter a place.")

    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
        try:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "limit": 1, "addressdetails": 1},
            )
            resp.raise_for_status()
            results = resp.json()
            if results:
                hit = results[0]
                return {
                    "query": query,
                    "label": _short_label(hit),
                    "lat": float(hit["lat"]),
                    "lon": float(hit["lon"]),
                }
        except (httpx.HTTPError, ValueError, KeyError):
            pass  # fall through to the backup geocoder

        # Backup: Open-Meteo's geocoder. City-level only, but very reliable.
        try:
            resp = await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": query, "count": 1, "language": "en", "format": "json"},
            )
            resp.raise_for_status()
            results = resp.json().get("results") or []
            if results:
                hit = results[0]
                parts = [hit.get("name"), hit.get("admin1"), hit.get("country")]
                return {
                    "query": query,
                    "label": ", ".join(p for p in parts if p),
                    "lat": float(hit["latitude"]),
                    "lon": float(hit["longitude"]),
                }
        except (httpx.HTTPError, ValueError, KeyError):
            pass

    raise GeoError(f"Couldn't find “{query}”. Try adding a city or postcode.")


def _short_label(hit: dict[str, Any]) -> str:
    address = hit.get("address") or {}
    place = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("suburb")
        or address.get("county")
    )
    region = address.get("state") or address.get("province")
    country = address.get("country")
    parts = [p for p in (place, region, country) if p]
    return ", ".join(parts) if parts else hit.get("display_name", "")[:80]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(a))


def midpoint(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, float]:
    """Great-circle midpoint between two coordinates."""
    p1, l1 = math.radians(lat1), math.radians(lon1)
    p2, l2 = math.radians(lat2), math.radians(lon2)
    bx = math.cos(p2) * math.cos(l2 - l1)
    by = math.cos(p2) * math.sin(l2 - l1)
    lat = math.atan2(
        math.sin(p1) + math.sin(p2),
        math.sqrt((math.cos(p1) + bx) ** 2 + by**2),
    )
    lon = l1 + math.atan2(by, math.cos(p1) + bx)
    return math.degrees(lat), math.degrees(lon)


async def drive_minutes(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> tuple[int, float, bool]:
    """Driving minutes and road km between two points.

    Returns (minutes, km, is_estimate). Falls back to a straight-line estimate
    if the routing service is unreachable.
    """
    straight_km = haversine_km(lat1, lon1, lat2, lon2)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(
                f"https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}",
                params={"overview": "false"},
            )
            resp.raise_for_status()
            data = resp.json()
            route = (data.get("routes") or [])[0]
            return (
                int(round(route["duration"] / 60)),
                round(route["distance"] / 1000, 1),
                False,
            )
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        # Rough city-driving assumption: roads are ~1.3x longer than the crow flies at ~45 km/h.
        road_km = straight_km * 1.3
        return int(round(road_km / 45 * 60)), round(road_km, 1), True


async def forecast(lat: float, lon: float, when: datetime) -> dict[str, Any]:
    """Hourly weather at a point, for the hour closest to `when` (local time there)."""
    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
        resp = await client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "hourly": "temperature_2m,apparent_temperature,precipitation_probability,"
                "weather_code,wind_speed_10m",
                "daily": "sunrise,sunset",
                "timezone": "auto",
                "forecast_days": 7,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    hourly = data.get("hourly") or {}
    times: list[str] = hourly.get("time") or []
    if not times:
        raise GeoError("Weather service returned no forecast for that spot.")

    target = when.replace(tzinfo=None, minute=0, second=0, microsecond=0)
    parsed = [datetime.fromisoformat(t) for t in times]
    # Snap to the closest available hour, and note if the request was out of range.
    idx = min(range(len(parsed)), key=lambda i: abs(parsed[i] - target))
    off_by = abs(parsed[idx] - target)

    code = (hourly.get("weather_code") or [None])[idx]
    daily = data.get("daily") or {}
    day_key = parsed[idx].date().isoformat()
    sunset = ""
    if daily.get("time") and day_key in daily["time"]:
        d_idx = daily["time"].index(day_key)
        sunset = (daily.get("sunset") or [""] * (d_idx + 1))[d_idx]

    return {
        "time": parsed[idx].isoformat(),
        "timezone": data.get("timezone", ""),
        "temperature_c": _at(hourly, "temperature_2m", idx),
        "feels_like_c": _at(hourly, "apparent_temperature", idx),
        "precipitation_chance": _at(hourly, "precipitation_probability", idx),
        "wind_kph": _at(hourly, "wind_speed_10m", idx),
        "description": WEATHER_CODES.get(code, "unknown conditions"),
        "sunset": sunset,
        "out_of_range": off_by > timedelta(hours=2),
    }


def _at(hourly: dict[str, Any], key: str, idx: int) -> Any:
    values = hourly.get(key) or []
    return values[idx] if idx < len(values) else None


async def reverse_label(lat: float, lon: float, between: tuple[str, str] | None = None) -> str:
    """A friendly name for the midpoint.

    Midpoints often land somewhere with no useful name — the middle of a lake,
    say — so anything vaguer than a town falls back to "between A and B".
    """
    fallback = f"halfway between {between[0]} and {between[1]}" if between else ""

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"lat": lat, "lon": lon, "format": "json", "zoom": 12},
            )
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError, KeyError):
        return fallback or f"{lat:.2f}, {lon:.2f}"

    address = data.get("address") or {}
    town = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("suburb")
        or address.get("municipality")
    )
    if town:
        return town
    return fallback or _short_label(data) or f"{lat:.2f}, {lon:.2f}"


def first_part(label: str) -> str:
    """'Toronto, Ontario, Canada' -> 'Toronto'."""
    return label.split(",")[0].strip() or label
