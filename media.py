"""Delivering MeowTunes audio as native Telegram audio messages."""

from __future__ import annotations

import asyncio
import contextlib
import html
import logging

from aiogram import Bot
from aiogram.enums import ChatAction
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.types import BufferedInputFile, Message

from config import Settings
from vasl_client import Track, VaslClient, VaslError, VaslMediaError

log = logging.getLogger(__name__)

FAV_CAPTION = "❤️ موزیک جدیدی که در وصل (MeowTunes) لایک کردید:"

# Telegram fetches audio by URL only up to ~20 MB; larger files must be uploaded.
URL_FETCH_LIMIT = 20 * 1024 * 1024
# Only small files are uploaded when the URL path fails: uploading even ~14 MB
# over a slow home connection can take minutes, so bigger files get a link.
SMALL_UPLOAD_LIMIT = 10 * 1024 * 1024
URL_SEND_ATTEMPTS = 3


def _safe_name(track: Track) -> str:
    base = f"{track.artist} - {track.title}" if track.artist else track.title
    cleaned = "".join(ch for ch in base if ch not in '\\/:*?"<>|\r\n\t').strip()
    return f"{(cleaned or 'track')[:80]}.{track.extension}"


def caption_for(track: Track, prefix: str | None = None, note: str | None = None) -> str:
    lines: list[str] = []
    if prefix:
        lines.append(prefix)
    lines.append(f"🎵 <b>{html.escape(track.title)}</b>")
    if track.artist:
        lines.append(f"👤 {html.escape(track.artist)}")
    if track.album:
        lines.append(f"💿 {html.escape(track.album)}")
    if note:
        lines.append(html.escape(note))
    return "\n".join(lines)[:1024]


async def send_track(
    bot: Bot,
    chat_id: int,
    client: VaslClient,
    track: Track,
    settings: Settings,
    *,
    prefix: str | None = None,
    note: str | None = None,
) -> bool:
    """Send one track as Telegram audio. Returns True when delivered."""
    with contextlib.suppress(TelegramAPIError):
        await bot.send_chat_action(chat_id, ChatAction.UPLOAD_VOICE)

    caption = caption_for(track, prefix=prefix, note=note)
    filename = _safe_name(track)
    # Bot API needs an uploaded thumbnail, not a URL (aiogram validates InputFile).
    thumbnail = await _thumbnail(client, track.cover_url)

    size = track.size
    # Preferred: let Telegram fetch the public CDN URL. This avoids uploading
    # tens of MB over a slow connection, which caused the send timeouts.
    if track.audio_url and (size is None or size <= URL_FETCH_LIMIT):
        for attempt in range(1, URL_SEND_ATTEMPTS + 1):
            try:
                await bot.send_audio(
                    chat_id=chat_id,
                    audio=track.audio_url,
                    caption=caption,
                    title=track.title[:64],
                    performer=(track.artist or "")[:64] or None,
                    duration=track.duration,
                    thumbnail=thumbnail,
                    parse_mode="HTML",
                )
                return True
            except TelegramBadRequest as exc:
                log.warning("send_audio(url) rejected (attempt %s): %s", attempt, exc)
                break
            except TelegramAPIError as exc:
                log.warning("send_audio(url) failed (attempt %s): %s", attempt, exc)
                if attempt < URL_SEND_ATTEMPTS:
                    await asyncio.sleep(1.5)

    # Uploading a big file over a slow link is unreliable: deliver a link instead.
    if track.audio_url and (size is None or size > SMALL_UPLOAD_LIMIT):
        await _safe_send_message(
            bot,
            chat_id,
            f"{caption}\n\n⚠️ حجم فایل ({size // (1024 * 1024) if size else '?'} مگابایت) برای "
            f'ارسال در تلگرام بیش از حد است؛ <a href="{html.escape(track.audio_url)}">دانلود مستقیم</a>',
        )
        return True

    try:
        data, _content_type = await client.download_audio(
            track, max_bytes=settings.max_audio_bytes
        )
    except VaslMediaError as exc:
        log.warning("track download failed", extra={"track_id": track.id, "error": str(exc)})
        if track.audio_url:
            await _safe_send_message(
                bot,
                chat_id,
                f"⚠️ «{html.escape(track.title)}» قابل ارسال نبود: {html.escape(str(exc))}\n"
                f'<a href="{html.escape(track.audio_url)}">لینک مستقیم</a>',
            )
        else:
            await _safe_send_message(
                bot,
                chat_id,
                f"⚠️ «{html.escape(track.title)}» قابل ارسال نبود: {html.escape(str(exc))}",
            )
        return False
    except VaslError as exc:
        log.warning("track fetch failed", extra={"track_id": track.id, "error": str(exc)})
        await _safe_send_message(
            bot, chat_id, f"⚠️ خطا در دریافت «{html.escape(track.title)}»: {html.escape(str(exc))}"
        )
        return False

    upload = BufferedInputFile(data, filename=filename)

    try:
        await bot.send_audio(
            chat_id=chat_id,
            audio=upload,
            caption=caption,
            title=track.title[:64],
            performer=(track.artist or "")[:64] or None,
            duration=track.duration,
            thumbnail=thumbnail,
            parse_mode="HTML",
        )
        return True
    except TelegramBadRequest as exc:
        log.warning("send_audio rejected, falling back to document: %s", exc)
    except TelegramAPIError as exc:
        log.warning("send_audio failed: %s", exc)
        link = (
            f'\n<a href="{html.escape(track.audio_url)}">دانلود مستقیم</a>'
            if track.audio_url
            else ""
        )
        await _safe_send_message(
            bot,
            chat_id,
            f"⚠️ ارسال «{html.escape(track.title)}» ناموفق بود: {html.escape(str(exc))}{link}",
        )
        return False
    except Exception:  # a send must never fail silently
        log.exception("send_audio raised unexpectedly for track %s", track.id)

    try:
        await bot.send_document(
            chat_id=chat_id,
            document=BufferedInputFile(data, filename=filename),
            caption=caption,
            parse_mode="HTML",
        )
        return True
    except TelegramAPIError as exc:
        log.warning("send_document failed: %s", exc)
        await _safe_send_message(
            bot, chat_id, f"⚠️ ارسال «{html.escape(track.title)}» ناموفق بود: {html.escape(str(exc))}"
        )
        return False
    except Exception:
        log.exception("send_document raised unexpectedly for track %s", track.id)
        await _safe_send_message(
            bot, chat_id, f"⚠️ ارسال «{html.escape(track.title)}» ناموفق بود."
        )
        return False


async def send_tracks(
    bot: Bot,
    chat_id: int,
    client: VaslClient,
    settings: Settings,
    tracks: list[Track],
    *,
    progress_message: Message | None = None,
    prefix: str | None = None,
) -> tuple[int, int]:
    """Send several tracks sequentially. Returns (sent, failed)."""
    sent = 0
    failed = 0
    total = len(tracks)
    for index, track in enumerate(tracks, start=1):
        ok = await send_track(bot, chat_id, client, track, settings, prefix=prefix)
        if ok:
            sent += 1
        else:
            failed += 1
        if progress_message is not None and (index == total or index % 3 == 0):
            with contextlib.suppress(TelegramAPIError):
                await progress_message.edit_text(
                    f"⬇️ در حال ارسال… {index} از {total}\n"
                    f"✅ ارسال‌شده: {sent} — ❌ ناموفق: {failed}"
                )
        await asyncio.sleep(0.4)
    return sent, failed


async def _thumbnail(client: VaslClient, url: str | None) -> BufferedInputFile | None:
    """Cover art as an upload — aiogram rejects plain URLs for `thumbnail`."""
    data = await client.fetch_thumbnail(url)
    return BufferedInputFile(data, filename="thumbnail.jpg") if data else None


async def _safe_send_message(bot: Bot, chat_id: int, text: str) -> None:
    with contextlib.suppress(TelegramAPIError):
        await bot.send_message(chat_id, text, parse_mode="HTML", disable_web_page_preview=True)
