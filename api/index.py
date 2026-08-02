"""Vercel entry point.

Vercel looks for a Python file under api/ and runs the ASGI app it finds here.
Everything real lives in backend/.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app import app  # noqa: E402

__all__ = ["app"]
