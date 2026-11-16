"""Runtime configuration, loaded from environment / .env."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# .env is the local developer file; real environment variables always win.
load_dotenv(override=False)

DEFAULT_API_BASE = "https://api2.vasl.social/api"
DEFAULT_CDN_BASE = "https://cdn.v-storage.cloud"


def _int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value >= minimum else default


def _float(name: str, default: float, minimum: float = 1.0) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value >= minimum else default


@dataclass(frozen=True, slots=True)
class Settings:
    bot_token: str
    api_base: str
    cdn_base: str
    database_path: str
    fav_poll_seconds: int
    http_timeout: float
    max_retries: int
    max_audio_mb: int
    page_size: int
    log_level: str

    @property
    def max_audio_bytes(self) -> int:
        return self.max_audio_mb * 1024 * 1024


def load_settings() -> Settings:
    """Build settings from the environment, failing fast on a missing token."""
    bot_token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    if not bot_token:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and add the "
            "token from @BotFather."
        )

    return Settings(
        bot_token=bot_token,
        api_base=(os.getenv("VASL_API_BASE") or DEFAULT_API_BASE).rstrip("/"),
        cdn_base=(os.getenv("VASL_CDN_BASE") or DEFAULT_CDN_BASE).rstrip("/"),
        database_path=os.getenv("DATABASE_PATH") or "data/meowtunes.sqlite3",
        fav_poll_seconds=_int("FAV_POLL_SECONDS", 15, minimum=5),
        http_timeout=_float("HTTP_TIMEOUT_SECONDS", 60.0),
        max_retries=_int("MAX_RETRIES", 3, minimum=0),
        max_audio_mb=_int("MAX_AUDIO_MB", 45),
        page_size=_int("PAGE_SIZE", 8, minimum=1),
        log_level=(os.getenv("LOG_LEVEL") or "INFO").upper(),
    )
