"""SQLite persistence for linked accounts, favorite dedupe and search cache."""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    telegram_id      INTEGER PRIMARY KEY,
    vasl_user_id     TEXT,
    vasl_display_name TEXT,
    vasl_token       TEXT,
    is_connected     INTEGER NOT NULL DEFAULT 0,
    fav_seeded       INTEGER NOT NULL DEFAULT 0,
    last_sync_at     TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS synced_favorites (
    telegram_id INTEGER NOT NULL,
    track_id    TEXT    NOT NULL,
    sent_at     TEXT    NOT NULL,
    PRIMARY KEY (telegram_id, track_id)
);

CREATE TABLE IF NOT EXISTS cache (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_attempts (
    telegram_id INTEGER NOT NULL,
    track_id    TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT NOT NULL,
    PRIMARY KEY (telegram_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_favorites_user ON synced_favorites (telegram_id);
CREATE INDEX IF NOT EXISTS idx_cache_created ON cache (created_at);
"""

CACHE_TTL_SECONDS = 60 * 30


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Database:
    """Thin async wrapper around a single SQLite connection."""

    def __init__(self, path: str):
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    # -- lifecycle ---------------------------------------------------------
    async def connect(self) -> None:
        if self.path != ":memory:":
            Path(self.path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.execute("PRAGMA busy_timeout=5000")
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()
        if self.path != ":memory:":
            # The file holds Vasl session tokens.
            with contextlib.suppress(OSError):
                os.chmod(self.path, 0o600)

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database.connect() must run first")
        return self._conn

    # -- users -------------------------------------------------------------
    async def get_user(self, telegram_id: int) -> dict[str, Any] | None:
        cursor = await self.conn.execute(
            "SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        return dict(row) if row else None

    async def save_connection(
        self,
        telegram_id: int,
        *,
        vasl_user_id: str | None,
        display_name: str | None,
        token: str,
    ) -> None:
        """Link a Vasl account.

        fav_seeded is reset so the caller can seed the new account's existing
        favorites silently before the watcher starts pushing new ones.
        """
        now = _now()
        await self.conn.execute(
            """
            INSERT INTO users (telegram_id, vasl_user_id, vasl_display_name, vasl_token,
                               is_connected, fav_seeded, last_sync_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET
                vasl_user_id = excluded.vasl_user_id,
                vasl_display_name = excluded.vasl_display_name,
                vasl_token = excluded.vasl_token,
                is_connected = 1,
                fav_seeded = 0,
                updated_at = excluded.updated_at
            """,
            (telegram_id, vasl_user_id, display_name, token, now, now),
        )
        await self.conn.commit()

    async def set_token(self, telegram_id: int, token: str) -> None:
        await self.conn.execute(
            "UPDATE users SET vasl_token = ?, updated_at = ? WHERE telegram_id = ?",
            (token, _now(), telegram_id),
        )
        await self.conn.commit()

    async def disconnect_user(self, telegram_id: int) -> None:
        await self.conn.execute(
            """
            UPDATE users SET is_connected = 0, vasl_token = NULL, fav_seeded = 0,
                             updated_at = ? WHERE telegram_id = ?
            """,
            (_now(), telegram_id),
        )
        await self.conn.commit()

    async def list_connected_users(self) -> list[dict[str, Any]]:
        cursor = await self.conn.execute(
            "SELECT * FROM users WHERE is_connected = 1 AND vasl_token IS NOT NULL"
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return [dict(row) for row in rows]

    async def mark_fav_seeded(self, telegram_id: int) -> None:
        await self.conn.execute(
            "UPDATE users SET fav_seeded = 1, last_sync_at = ? WHERE telegram_id = ?",
            (_now(), telegram_id),
        )
        await self.conn.commit()

    async def touch_sync(self, telegram_id: int) -> None:
        await self.conn.execute(
            "UPDATE users SET last_sync_at = ? WHERE telegram_id = ?",
            (_now(), telegram_id),
        )
        await self.conn.commit()

    # -- favorites ---------------------------------------------------------
    async def seed_favorites(self, telegram_id: int, track_ids: list[str]) -> int:
        """Record favorites without sending them (first-time account linking)."""
        rows = [(telegram_id, str(track_id), _now()) for track_id in track_ids if track_id]
        if not rows:
            return 0
        await self.conn.executemany(
            "INSERT OR IGNORE INTO synced_favorites (telegram_id, track_id, sent_at) VALUES (?, ?, ?)",
            rows,
        )
        await self.conn.commit()
        return len(rows)

    async def mark_favorite_sent(self, telegram_id: int, track_id: str) -> None:
        await self.conn.execute(
            "INSERT OR IGNORE INTO synced_favorites (telegram_id, track_id, sent_at) VALUES (?, ?, ?)",
            (telegram_id, str(track_id), _now()),
        )
        await self.conn.commit()

    async def sent_track_ids(self, telegram_id: int) -> set[str]:
        cursor = await self.conn.execute(
            "SELECT track_id FROM synced_favorites WHERE telegram_id = ?", (telegram_id,)
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return {str(row["track_id"]) for row in rows}

    async def attempt_count(self, telegram_id: int, track_id: str) -> int:
        cursor = await self.conn.execute(
            "SELECT attempts FROM favorite_attempts WHERE telegram_id = ? AND track_id = ?",
            (telegram_id, str(track_id)),
        )
        row = await cursor.fetchone()
        await cursor.close()
        return int(row["attempts"]) if row else 0

    async def record_attempt(self, telegram_id: int, track_id: str) -> int:
        await self.conn.execute(
            """
            INSERT INTO favorite_attempts (telegram_id, track_id, attempts, last_attempt_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(telegram_id, track_id) DO UPDATE SET
                attempts = attempts + 1,
                last_attempt_at = excluded.last_attempt_at
            """,
            (telegram_id, str(track_id), _now()),
        )
        await self.conn.commit()
        return await self.attempt_count(telegram_id, track_id)

    async def clear_attempt(self, telegram_id: int, track_id: str) -> None:
        await self.conn.execute(
            "DELETE FROM favorite_attempts WHERE telegram_id = ? AND track_id = ?",
            (telegram_id, str(track_id)),
        )
        await self.conn.commit()

    async def favorite_count(self, telegram_id: int) -> int:
        cursor = await self.conn.execute(
            "SELECT COUNT(*) AS n FROM synced_favorites WHERE telegram_id = ?", (telegram_id,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        return int(row["n"]) if row else 0

    # -- cache -------------------------------------------------------------
    async def cache_put(self, kind: str, payload: dict[str, Any], ttl: int = CACHE_TTL_SECONDS) -> str:
        cache_id = secrets.token_urlsafe(6)[:8]
        await self.conn.execute(
            "INSERT OR REPLACE INTO cache (id, kind, payload, created_at) VALUES (?, ?, ?, ?)",
            (cache_id, kind, json.dumps(payload, ensure_ascii=False), time.time()),
        )
        await self.conn.execute(
            "DELETE FROM cache WHERE created_at < ?", (time.time() - ttl,)
        )
        await self.conn.commit()
        return cache_id

    async def cache_get(self, cache_id: str, kind: str | None = None) -> dict[str, Any] | None:
        cursor = await self.conn.execute(
            "SELECT kind, payload FROM cache WHERE id = ?", (cache_id,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        if not row:
            return None
        if kind and row["kind"] != kind:
            return None
        try:
            return json.loads(row["payload"])
        except json.JSONDecodeError:
            return None
