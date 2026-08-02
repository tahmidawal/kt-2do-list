"""Storage for the K & T to-do list.

Runs on SQLite locally and Postgres when deployed — Vercel's filesystem is
wiped between requests, so anything hosted there needs a real database.
Set DATABASE_URL to switch; without it you get the local file.

The SQL is deliberately written to work on both: positional placeholders,
integers rather than booleans, and INSERT ... RETURNING (SQLite 3.35+).
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "kt.db"


def database_url() -> str:
    return os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or ""


def using_postgres() -> bool:
    return bool(database_url())


ITEM_COLUMNS = """
    title            TEXT    NOT NULL,
    notes            TEXT    NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    setting          TEXT    NOT NULL DEFAULT 'either',
    weather_sensitive INTEGER NOT NULL DEFAULT 0,
    best_time        TEXT    NOT NULL DEFAULT 'anytime',
    location_hint    TEXT    NOT NULL DEFAULT '',
    cost             TEXT    NOT NULL DEFAULT '$',
    tags             TEXT    NOT NULL DEFAULT '[]',
    done             INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL
"""


@contextmanager
def _cursor() -> Iterator[Any]:
    """A cursor for whichever backend is configured, committed on success."""
    if using_postgres():
        import psycopg

        conn = psycopg.connect(database_url(), autocommit=False)
        try:
            with conn.cursor() as cur:
                yield cur
            conn.commit()
        finally:
            conn.close()
    else:
        import sqlite3

        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        try:
            cur = conn.cursor()
            yield cur
            conn.commit()
        finally:
            conn.close()


def _q(sql: str) -> str:
    """SQLite uses ? placeholders, Postgres uses %s."""
    return sql.replace("?", "%s") if using_postgres() else sql


def init() -> None:
    identity = (
        "id SERIAL PRIMARY KEY" if using_postgres() else "id INTEGER PRIMARY KEY AUTOINCREMENT"
    )
    with _cursor() as cur:
        cur.execute(f"CREATE TABLE IF NOT EXISTS items ({identity},{ITEM_COLUMNS})")
        cur.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )


FIELDS = [
    "id",
    "title",
    "notes",
    "duration_minutes",
    "setting",
    "weather_sensitive",
    "best_time",
    "location_hint",
    "cost",
    "tags",
    "done",
    "created_at",
]
SELECT = f"SELECT {', '.join(FIELDS)} FROM items"


def _row_to_item(row: tuple[Any, ...]) -> dict[str, Any]:
    item = dict(zip(FIELDS, row))
    item["done"] = bool(item["done"])
    item["weather_sensitive"] = bool(item["weather_sensitive"])
    try:
        item["tags"] = json.loads(item["tags"])
    except (json.JSONDecodeError, TypeError):
        item["tags"] = []
    return item


def list_items(include_done: bool = True) -> list[dict[str, Any]]:
    sql = SELECT + ("" if include_done else " WHERE done = 0") + " ORDER BY done ASC, id DESC"
    with _cursor() as cur:
        cur.execute(sql)
        return [_row_to_item(r) for r in cur.fetchall()]


def get_item(item_id: int) -> dict[str, Any] | None:
    with _cursor() as cur:
        cur.execute(_q(f"{SELECT} WHERE id = ?"), (item_id,))
        row = cur.fetchone()
    return _row_to_item(row) if row else None


def add_item(data: dict[str, Any]) -> dict[str, Any] | None:
    values = (
        (data.get("title") or "").strip() or "Untitled",
        data.get("notes") or "",
        int(data.get("duration_minutes") or 60),
        data.get("setting") or "either",
        1 if data.get("weather_sensitive") else 0,
        data.get("best_time") or "anytime",
        data.get("location_hint") or "",
        data.get("cost") or "$",
        json.dumps(data.get("tags") or []),
        0,
        datetime.now(timezone.utc).isoformat(),
    )
    with _cursor() as cur:
        cur.execute(
            _q(
                """INSERT INTO items
                   (title, notes, duration_minutes, setting, weather_sensitive,
                    best_time, location_hint, cost, tags, done, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"""
            ),
            values,
        )
        new_id = cur.fetchone()[0]
    return get_item(new_id)


UPDATABLE = {
    "title",
    "notes",
    "duration_minutes",
    "setting",
    "weather_sensitive",
    "best_time",
    "location_hint",
    "cost",
    "done",
}


def update_item(item_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
    fields = {k: v for k, v in changes.items() if k in UPDATABLE}
    for flag in ("done", "weather_sensitive"):
        if flag in fields:
            fields[flag] = 1 if fields[flag] else 0
    if not fields:
        return get_item(item_id)

    assignments = ", ".join(f"{k} = ?" for k in fields)
    with _cursor() as cur:
        cur.execute(
            _q(f"UPDATE items SET {assignments} WHERE id = ?"),
            (*fields.values(), item_id),
        )
    return get_item(item_id)


def delete_item(item_id: int) -> None:
    with _cursor() as cur:
        cur.execute(_q("DELETE FROM items WHERE id = ?"), (item_id,))


def get_setting(key: str, default: str = "") -> str:
    with _cursor() as cur:
        cur.execute(_q("SELECT value FROM settings WHERE key = ?"), (key,))
        row = cur.fetchone()
    return row[0] if row else default


def set_setting(key: str, value: str) -> None:
    with _cursor() as cur:
        cur.execute(
            _q(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value"
            ),
            (key, value),
        )
