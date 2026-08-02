"""A single shared password, so the list isn't open to the whole internet.

Two people, one password, no accounts. Locally you can skip it entirely by
leaving APP_PASSWORD unset; anywhere public it should always be set.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time

from fastapi import HTTPException, Request

COOKIE_NAME = "kt_session"
MAX_AGE = 60 * 60 * 24 * 90  # three months; it's a to-do list, not a bank


def password() -> str:
    return os.environ.get("APP_PASSWORD", "")


def required() -> bool:
    return bool(password())


def _secret() -> bytes:
    # Falls back to the password so a forgotten SECRET_KEY can't silently
    # leave every session signed with a predictable empty key.
    return (os.environ.get("SECRET_KEY") or password() or "unset").encode()


def _sign(payload: str) -> str:
    digest = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{digest}"


def issue_token() -> str:
    return _sign(str(int(time.time())))


def _valid(token: str) -> bool:
    issued, _, digest = token.partition(".")
    if not issued or not digest:
        return False
    if not hmac.compare_digest(_sign(issued), token):
        return False
    try:
        return time.time() - int(issued) < MAX_AGE
    except ValueError:
        return False


def check_password(attempt: str) -> bool:
    return bool(password()) and secrets.compare_digest(attempt or "", password())


def is_signed_in(request: Request) -> bool:
    if not required():
        return True
    return _valid(request.cookies.get(COOKIE_NAME, ""))


def require(request: Request) -> None:
    """FastAPI dependency: 401 unless the caller is signed in."""
    if not is_signed_in(request):
        raise HTTPException(status_code=401, detail="Please sign in.")
