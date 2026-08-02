"""Idea parsing and date suggestions, via OpenRouter.

OpenRouter speaks the OpenAI chat-completions dialect, so this is a plain HTTPS
call — no extra SDK. Swap the model any time with OPENROUTER_MODEL in .env.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Smart enough to weigh weather against travel time and write a decent sentence,
# cheap enough that a $5 budget lasts thousands of dates.
DEFAULT_MODEL = "google/gemini-2.5-flash"

TIMEOUT = httpx.Timeout(90.0)


class LLMNotConfigured(Exception):
    """Raised when no OpenRouter API key is available."""


def model_name() -> str:
    return os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL)


def _api_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise LLMNotConfigured(
            "No OPENROUTER_API_KEY found. Put it in the .env file next to this app and restart."
        )
    return key


async def _json_call(
    *,
    system: str,
    prompt: str,
    schema: dict[str, Any],
    schema_name: str,
    temperature: float = 0.4,
) -> dict[str, Any]:
    payload = {
        "model": model_name(),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema_name, "strict": True, "schema": schema},
        },
    }
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
        # OpenRouter uses these for its dashboard; harmless and helpful.
        "HTTP-Referer": "http://localhost",
        "X-Title": "K & T 2do list",
    }

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.post(API_URL, headers=headers, json=payload)

    if response.status_code == 401:
        raise RuntimeError("OpenRouter rejected the API key.")
    if response.status_code == 402:
        raise RuntimeError("The OpenRouter credit for this key has run out.")
    if response.status_code == 429:
        raise RuntimeError("OpenRouter is rate-limiting us — wait a moment and try again.")
    if response.status_code >= 400:
        detail = _error_detail(response)
        raise RuntimeError(f"OpenRouter returned {response.status_code}: {detail}")

    body = response.json()
    if "error" in body:  # OpenRouter can return 200 with an error body
        raise RuntimeError(str(body["error"].get("message", body["error"])))

    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise RuntimeError(f"Unexpected response from OpenRouter: {body}") from exc

    if not (content or "").strip():
        raise RuntimeError("The model returned nothing. Try rewording it.")

    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"The model didn't return valid JSON: {content[:200]}") from exc


def _error_detail(response: httpx.Response) -> str:
    try:
        return str(response.json().get("error", {}).get("message", response.text[:200]))
    except ValueError:
        return response.text[:200]


# --------------------------------------------------------------------------
# 1. Turning "let's go to that ramen place" into a structured to-do item
# --------------------------------------------------------------------------

_ITEM_PROPERTIES = {
    "title": {
        "type": "string",
        "description": "Short, natural name for the activity, e.g. 'Try the ramen place on Queen St'.",
    },
    "notes": {
        "type": "string",
        "description": "Any extra detail the person mentioned. Empty string if none.",
    },
    "duration_minutes": {
        "type": "integer",
        "description": (
            "Realistic time for the activity itself, excluding travel. A coffee is 45-60, "
            "a sit-down dinner 90-120, a movie 150, a hike 180-300, a day trip 480."
        ),
    },
    "setting": {"type": "string", "enum": ["outdoor", "indoor", "either"]},
    "weather_sensitive": {
        "type": "boolean",
        "description": "True if bad weather would genuinely ruin it (picnic, hike, beach).",
    },
    "best_time": {"type": "string", "enum": ["morning", "afternoon", "evening", "anytime"]},
    "location_hint": {
        "type": "string",
        "description": "A place name if one was mentioned or is obvious, otherwise an empty string.",
    },
    "cost": {"type": "string", "enum": ["free", "$", "$$", "$$$"]},
    "tags": {
        "type": "array",
        "items": {"type": "string"},
        "description": "1-3 lowercase keywords, e.g. ['food','cozy'].",
    },
}

PARSE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": _ITEM_PROPERTIES,
                "required": list(_ITEM_PROPERTIES),
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

PARSE_SYSTEM = """You help a couple, Katherine and Tahmid, keep a list of things they want to do together.

They dump ideas in casually — sometimes one, sometimes several in one breath. Split what they \
write into separate activities, one entry per distinct thing to do. If they wrote one idea, \
return one item; don't invent extras.

Estimate duration like a person who has actually done the thing would: include the whole \
experience (ordering, eating, lingering) but not travel time. Round to sensible chunks.

Keep titles in their own words where you can — this is their list, not yours."""


async def parse_ideas(raw_text: str) -> list[dict[str, Any]]:
    """Split free-text input into one or more structured activities."""
    result = await _json_call(
        system=PARSE_SYSTEM,
        prompt=f"Add this to our list:\n\n{raw_text.strip()}",
        schema=PARSE_SCHEMA,
        schema_name="parsed_activities",
        temperature=0.3,
    )
    return result.get("items", [])


# --------------------------------------------------------------------------
# 2. Picking what to actually do, given where they are and what it's like out
# --------------------------------------------------------------------------

SUGGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {
            "type": "string",
            "description": "One short sentence setting the scene, e.g. 'Cold and drizzly — this is an indoors day.'",
        },
        "picks": {
            "type": "array",
            "description": "Two or three activities from the list, best first.",
            "items": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "why": {
                        "type": "string",
                        "description": "One or two plain sentences on why this fits today. Mention weather, travel, or timing when it's the reason.",
                    },
                },
                "required": ["item_id", "title", "why"],
                "additionalProperties": False,
            },
        },
        "skip_today": {
            "type": "array",
            "description": "Up to two things worth explicitly ruling out today. Empty array if nothing stands out.",
            "items": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "why": {"type": "string"},
                },
                "required": ["item_id", "title", "why"],
                "additionalProperties": False,
            },
        },
        "meeting_note": {
            "type": "string",
            "description": "One line about where to meet or how the travel splits, e.g. 'Roughly even — 25 min each to the middle.'",
        },
    },
    "required": ["headline", "picks", "skip_today", "meeting_note"],
    "additionalProperties": False,
}

SUGGEST_SYSTEM = """You are helping Katherine and Tahmid pick what to do on a date, right now.

They already wrote down everything they want to do — your job is only to choose from that list, \
never to invent new activities. Every item_id you return must be one from the list you are given.

The time budget is already worked out for you. Every item carries fits_time_budget, and \
time_budget.longest_activity_that_fits_minutes is the most time they can spend once the driving \
is accounted for. Do not do this arithmetic yourself and do not second-guess those flags.

Weigh, in roughly this order:
1. Does it fit? Anything with fits_time_budget false is too long for today — leave it out. Only \
   ever pick one if literally nothing fits, and then say plainly in the headline that everything \
   on the list needs more time than they have.
2. Does the weather work? Never send them on an outdoor, weather-sensitive activity into rain, \
   storms, or bitter cold. Watch the sunset time too — an outdoor thing after dark is no good.
3. Is the travel fair? Neither person should do dramatically more driving than the other unless \
   the activity is clearly worth it.
4. Does it suit the time of day, and will they still have daylight if that matters?
5. Have they been meaning to do it for a while? Older ideas deserve a nudge.

Write like a friend texting them, not a travel agent. Short sentences. No bullet lists inside \
your reasons, no headers, no emoji. Say the real reason plainly — "the rain kills the picnic" \
beats "weather conditions are suboptimal".

If nothing on the list fits (everything is too long, or it's all outdoors in a storm), say so \
honestly in the headline and pick the least-bad options anyway."""


async def recommend(context: dict[str, Any]) -> dict[str, Any]:
    """Rank the couple's list against today's weather, distance, and time budget."""
    return await _json_call(
        system=SUGGEST_SYSTEM,
        prompt=(
            "Here is everything you need. Pick what we should do.\n\n"
            + json.dumps(context, indent=2, default=str)
        ),
        schema=SUGGEST_SCHEMA,
        schema_name="date_suggestion",
        temperature=0.5,
    )
