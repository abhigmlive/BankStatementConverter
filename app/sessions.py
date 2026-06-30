"""In-memory session store for uploaded PDFs.

Each upload gets a short id.  The raw bytes and an open :class:`PdfDocument` are
kept in memory with a last-access timestamp; idle sessions are evicted so the
process does not grow without bound.  This is deliberately simple — a single
process, suitable for self-hosting.  Swap for Redis/disk to scale out.
"""

from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field

from .pdfdoc import PdfDocument

SESSION_TTL_SECONDS = 60 * 60  # evict after 1h idle
MAX_SESSIONS = 200


@dataclass
class Session:
    id: str
    filename: str
    data: bytes
    pdf: PdfDocument
    created: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def _evict_locked(self) -> None:
        now = time.time()
        stale = [sid for sid, s in self._sessions.items() if now - s.last_access > SESSION_TTL_SECONDS]
        for sid in stale:
            self._drop_locked(sid)
        if len(self._sessions) > MAX_SESSIONS:
            oldest = sorted(self._sessions.values(), key=lambda s: s.last_access)
            for s in oldest[: len(self._sessions) - MAX_SESSIONS]:
                self._drop_locked(s.id)

    def _drop_locked(self, sid: str) -> None:
        s = self._sessions.pop(sid, None)
        if s:
            s.pdf.close()

    def create(self, filename: str, data: bytes) -> Session:
        pdf = PdfDocument(data)
        sid = secrets.token_urlsafe(12)
        sess = Session(id=sid, filename=filename, data=data, pdf=pdf)
        with self._lock:
            self._evict_locked()
            self._sessions[sid] = sess
        return sess

    def get(self, sid: str) -> Session | None:
        with self._lock:
            s = self._sessions.get(sid)
            if s:
                s.last_access = time.time()
            return s

    def drop(self, sid: str) -> None:
        with self._lock:
            self._drop_locked(sid)


store = SessionStore()
