"""K & T 2do list — a shared list that tells you what to actually do tonight."""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
UPLOADS = STATIC / "uploads"


def _load_env() -> None:
    """Read KEY=value pairs from .env without adding a dependency."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


_load_env()

from . import auth, db, geo, llm, photos  # noqa: E402  (import after .env is loaded)

app = FastAPI(title="K & T 2do list")

# Every signed-in endpoint depends on this. Locally, with no APP_PASSWORD set,
# it lets everything through.
signed_in = Depends(auth.require)

_ready = False


def _ensure_ready() -> None:
    """Create tables on first use. Serverless starts cold, so this can't be startup-only."""
    global _ready
    if not _ready:
        db.init()
        _ready = True


@app.middleware("http")
async def _prepare(request: Request, call_next):
    _ensure_ready()
    return await call_next(request)


# ---------------------------------------------------------------- models

class NewIdea(BaseModel):
    text: str = Field(min_length=1)


class ItemPatch(BaseModel):
    title: str | None = None
    notes: str | None = None
    duration_minutes: int | None = None
    setting: str | None = None
    weather_sensitive: bool | None = None
    best_time: str | None = None
    location_hint: str | None = None
    cost: str | None = None
    done: bool | None = None


class SuggestRequest(BaseModel):
    katherine_location: str
    tahmid_location: str
    available_minutes: int | None = None
    when: str | None = None  # local ISO datetime, e.g. "2026-08-01T18:00"


class Login(BaseModel):
    password: str


# ---------------------------------------------------------------- status & sign-in

@app.get("/api/status")
async def status(request: Request) -> dict[str, Any]:
    """Safe to call signed out — it's what tells the page to show the lock screen."""
    if not auth.is_signed_in(request):
        return {"signed_in": False, "password_required": True}

    return {
        "signed_in": True,
        "password_required": auth.required(),
        "llm_configured": bool(os.environ.get("OPENROUTER_API_KEY")),
        "model": llm.model_name(),
        "background": db.get_setting("background", ""),
        "portrait": db.get_setting("portrait", ""),
        "katherine_location": db.get_setting("katherine_location", ""),
        "tahmid_location": db.get_setting("tahmid_location", ""),
    }


@app.post("/api/login")
async def login(body: Login, response: Response) -> dict[str, bool]:
    if not auth.required():
        return {"signed_in": True}
    if not auth.check_password(body.password):
        raise HTTPException(status_code=401, detail="That's not the password.")

    response.set_cookie(
        auth.COOKIE_NAME,
        auth.issue_token(),
        max_age=auth.MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=bool(os.environ.get("VERCEL")),
    )
    return {"signed_in": True}


@app.post("/api/logout")
async def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(auth.COOKIE_NAME)
    return {"signed_in": False}


# ---------------------------------------------------------------- items

@app.get("/api/items", dependencies=[signed_in])
async def get_items() -> list[dict[str, Any]]:
    return db.list_items()


@app.post("/api/items", dependencies=[signed_in])
async def create_items(idea: NewIdea) -> dict[str, Any]:
    try:
        parsed = await llm.parse_ideas(idea.text)
    except llm.LLMNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # network hiccup, bad JSON, refusal
        raise HTTPException(
            status_code=502, detail=f"Couldn't read that idea: {exc}"
        ) from exc

    if not parsed:
        raise HTTPException(status_code=422, detail="Couldn't find an activity in that.")

    created = [db.add_item(p) for p in parsed]
    return {"created": created}


@app.patch("/api/items/{item_id}", dependencies=[signed_in])
async def patch_item(item_id: int, patch: ItemPatch) -> dict[str, Any]:
    changes = patch.model_dump(exclude_none=True)
    item = db.update_item(item_id, changes)
    if item is None:
        raise HTTPException(status_code=404, detail="No such item.")
    return item


@app.delete("/api/items/{item_id}", dependencies=[signed_in])
async def remove_item(item_id: int) -> dict[str, str]:
    db.delete_item(item_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------- suggest

def _time_of_day(when: datetime) -> str:
    hour = when.hour
    if hour < 11:
        return "morning"
    if hour < 17:
        return "afternoon"
    return "evening"


@app.post("/api/suggest", dependencies=[signed_in])
async def suggest(req: SuggestRequest) -> dict[str, Any]:
    items = db.list_items(include_done=False)
    if not items:
        raise HTTPException(
            status_code=422, detail="Your list is empty — add something you want to do first."
        )

    when = datetime.now()
    if req.when:
        try:
            when = datetime.fromisoformat(req.when)
        except ValueError:
            pass

    try:
        katherine = await geo.geocode(req.katherine_location)
        tahmid = await geo.geocode(req.tahmid_location)
    except geo.GeoError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    mid_lat, mid_lon = geo.midpoint(katherine["lat"], katherine["lon"], tahmid["lat"], tahmid["lon"])

    try:
        weather = await geo.forecast(mid_lat, mid_lon, when)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Couldn't get the forecast: {exc}"
        ) from exc

    katherine_min, katherine_km, k_est = await geo.drive_minutes(
        katherine["lat"], katherine["lon"], mid_lat, mid_lon
    )
    tahmid_min, tahmid_km, t_est = await geo.drive_minutes(
        tahmid["lat"], tahmid["lon"], mid_lat, mid_lon
    )
    apart_km = round(geo.haversine_km(katherine["lat"], katherine["lon"], tahmid["lat"], tahmid["lon"]), 1)
    middle_label = await geo.reverse_label(
        mid_lat,
        mid_lon,
        between=(geo.first_part(katherine["label"]), geo.first_part(tahmid["label"])),
    )

    # Whoever drives further sets the limit: they leave home, do the thing, drive back.
    longest_drive = max(katherine_min, tahmid_min)
    round_trip = longest_drive * 2
    max_activity = (
        max(req.available_minutes - round_trip, 0) if req.available_minutes else None
    )

    def fits(item: dict[str, Any]) -> bool:
        return max_activity is None or item["duration_minutes"] <= max_activity

    context = {
        "now": when.strftime("%A %d %B, %-I:%M %p"),
        "time_of_day": _time_of_day(when),
        "time_budget": {
            "minutes_available_door_to_door": req.available_minutes,
            "round_trip_travel_minutes": round_trip,
            "longest_activity_that_fits_minutes": max_activity,
        },
        "weather_at_midpoint": {
            "conditions": weather["description"],
            "temperature_c": weather["temperature_c"],
            "feels_like_c": weather["feels_like_c"],
            "chance_of_rain_percent": weather["precipitation_chance"],
            "wind_kph": weather["wind_kph"],
            "sunset": weather["sunset"],
        },
        "travel": {
            "meeting_area": middle_label,
            "katherine_drive_minutes": katherine_min,
            "tahmid_drive_minutes": tahmid_min,
            "distance_apart_km": apart_km,
            "estimates_only": k_est or t_est,
        },
        "list": [
            {
                "item_id": i["id"],
                "title": i["title"],
                "notes": i["notes"],
                "duration_minutes": i["duration_minutes"],
                "fits_time_budget": fits(i),
                "setting": i["setting"],
                "weather_sensitive": i["weather_sensitive"],
                "best_time": i["best_time"],
                "location_hint": i["location_hint"],
                "cost": i["cost"],
                "tags": i["tags"],
                "added_on": i["created_at"][:10],
            }
            for i in items
        ],
    }

    try:
        result = await llm.recommend(context)
    except llm.LLMNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Couldn't pick anything: {exc}") from exc

    db.set_setting("katherine_location", req.katherine_location)
    db.set_setting("tahmid_location", req.tahmid_location)

    # Door-to-door totals are arithmetic, so work them out here rather than
    # trusting the model to add up. Drop any pick that isn't a real item.
    by_id = {i["id"]: i for i in items}
    picks = []
    for pick in result.get("picks") or []:
        item = by_id.get(pick.get("item_id"))
        if item is None:
            continue
        pick["title"] = item["title"]
        pick["total_minutes"] = item["duration_minutes"] + round_trip
        pick["over_budget"] = not fits(item)
        picks.append(pick)
    result["picks"] = picks

    result["skip_today"] = [
        skip for skip in (result.get("skip_today") or []) if skip.get("item_id") in by_id
    ]

    return {
        "suggestion": result,
        "weather": weather,
        "travel": {
            "meeting_area": middle_label,
            "katherine": {"label": katherine["label"], "minutes": katherine_min, "km": katherine_km},
            "tahmid": {"label": tahmid["label"], "minutes": tahmid_min, "km": tahmid_km},
            "apart_km": apart_km,
            "estimates_only": k_est or t_est,
        },
    }


# ---------------------------------------------------------------- background photo

ALLOWED_IMAGES = {"image/jpeg", "image/png", "image/webp"}


@app.post("/api/background", dependencies=[signed_in])
async def set_background(file: UploadFile) -> dict[str, str]:
    if (file.content_type or "") not in ALLOWED_IMAGES:
        raise HTTPException(status_code=415, detail="Please pick a JPG, PNG, or WebP photo.")

    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="That photo is over 25 MB — pick a smaller one.")

    try:
        urls = await photos.save(data)
    except photos.PhotoError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc

    for name, url in urls.items():
        db.set_setting(name, url)
    return urls


# ---------------------------------------------------------------- static site

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")
