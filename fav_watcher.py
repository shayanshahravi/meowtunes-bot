"""Background watcher: push newly liked MeowTunes tracks to Telegram."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError

from config import Settings
from database import Database
from media import FAV_CAPTION, send_track
from vasl_client import Track, VaslAuthError, VaslClient, VaslError

log = logging.getLogger(__name__)

# A track that cannot be delivered (e.g. too large / network) is retried this
# many times, then skipped so one bad file cannot hammer the loop forever.
MAX_DELIVERY_ATTEMPTS = 3


class FavoriteWatcher:
    """Polls /music/liked for every linked account and sends what is new."""

    def __init__(
        self,
        db: Database,
        client: VaslClient,
        bot: Bot,
        settings: Settings,
    ):
        self.db = db
        self.client = client
        self.bot = bot
        self.settings = settings
        self._task: asyncio.Task[None] | None = None

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="favorite-watcher")
            log.info("favorite watcher started (interval=%ss)", self.settings.fav_poll_seconds)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # never let one bad cycle kill the worker
                log.exception("favorite watcher cycle failed")
            await asyncio.sleep(self.settings.fav_poll_seconds)

    # -- one pass ----------------------------------------------------------
    async def tick(self) -> None:
        users = await self.db.list_connected_users()
        for user in users:
            try:
                await self.poll_user(user)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("favorite poll failed for user %s", user.get("telegram_id"))
            await asyncio.sleep(0.5)

    async def poll_user(self, user: dict[str, Any]) -> None:
        telegram_id = int(user["telegram_id"])
        token = user.get("vasl_token")
        if not token:
            return

        try:
            favorites = await self.client.get_user_favorites(token, limit=50)
        except VaslAuthError as exc:
            log.info("vasl token invalid for %s: %s", telegram_id, exc)
            await self._expire_user(telegram_id)
            return
        except VaslError as exc:
            log.warning("favorites fetch failed for %s: %s", telegram_id, exc)
            return

        if not user.get("fav_seeded"):
            # Connected before seeding finished (or legacy row): seed silently.
            seeded = await self.db.seed_favorites(telegram_id, [t.id for t in favorites])
            await self.db.mark_fav_seeded(telegram_id)
            log.info("seeded %s existing favorites for %s", seeded, telegram_id)
            return

        already_sent = await self.db.sent_track_ids(telegram_id)
        pending = [track for track in favorites if track.id not in already_sent]
        if not pending:
            await self.db.touch_sync(telegram_id)
            return

        # /music/liked returns newest first; send oldest first for a natural order.
        for track in reversed(pending):
            attempts = await self.db.attempt_count(telegram_id, track.id)
            if attempts >= MAX_DELIVERY_ATTEMPTS:
                continue  # give up quietly instead of retrying forever
            delivered = await send_track(
                self.bot,
                telegram_id,
                self.client,
                track,
                self.settings,
                prefix=FAV_CAPTION,
            )
            if delivered:
                await self.db.mark_favorite_sent(telegram_id, track.id)
                await self.db.clear_attempt(telegram_id, track.id)
                log.info("favorite delivered: %s -> %s", track.id, telegram_id)
            else:
                count = await self.db.record_attempt(telegram_id, track.id)
                log.warning(
                    "favorite delivery failed (%s/%s): %s -> %s",
                    count, MAX_DELIVERY_ATTEMPTS, track.id, telegram_id,
                )
                if count >= MAX_DELIVERY_ATTEMPTS:
                    with contextlib.suppress(TelegramAPIError):
                        await self.bot.send_message(
                            telegram_id,
                            f"⚠️ ارسال «{track.title}» پس از {MAX_DELIVERY_ATTEMPTS} تلاش ناموفق بود "
                            "(فایل خیلی بزرگ یا شبکه). از /search دوباره امتحان کنید.",
                        )
            await asyncio.sleep(1.0)

        await self.db.touch_sync(telegram_id)

    async def _expire_user(self, telegram_id: int) -> None:
        await self.db.disconnect_user(telegram_id)
        with contextlib.suppress(TelegramAPIError):
            await self.bot.send_message(
                telegram_id,
                "⚠️ اتصال اکانت وصل شما منقضی شد.\n"
                "برای ادامه ارسال خودکار لایک‌ها، دوباره /connect را بزنید.",
            )

    # -- manual full sync --------------------------------------------------
    async def sync_all(self, telegram_id: int) -> tuple[int, int]:
        """Send every favorite that was never delivered. Returns (sent, failed)."""
        user = await self.db.get_user(telegram_id)
        if not user or not user.get("is_connected") or not user.get("vasl_token"):
            raise VaslAuthError("اکانت وصل متصل نیست")

        favorites = await self.client.get_user_favorites(user["vasl_token"], limit=50)
        already_sent = await self.db.sent_track_ids(telegram_id)
        pending = [track for track in favorites if track.id not in already_sent]

        sent = 0
        failed = 0
        for track in reversed(pending):
            if await self.db.attempt_count(telegram_id, track.id) >= MAX_DELIVERY_ATTEMPTS:
                continue
            delivered = await send_track(
                self.bot,
                telegram_id,
                self.client,
                track,
                self.settings,
                prefix="🎧 از لایک‌های شما در وصل (MeowTunes):",
            )
            if delivered:
                await self.db.mark_favorite_sent(telegram_id, track.id)
                await self.db.clear_attempt(telegram_id, track.id)
                sent += 1
            else:
                await self.db.record_attempt(telegram_id, track.id)
                failed += 1
            await asyncio.sleep(0.6)
        await self.db.touch_sync(telegram_id)
        return sent, failed

    async def favorite_snapshot(self, telegram_id: int, limit: int = 50) -> list[Track]:
        user = await self.db.get_user(telegram_id)
        if not user or not user.get("vasl_token"):
            raise VaslAuthError("اکانت وصل متصل نیست")
        return await self.client.get_user_favorites(user["vasl_token"], limit=limit)
