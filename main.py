"""Entrypoint: wires the client, database, watcher and Telegram dispatcher."""

from __future__ import annotations

import asyncio
import logging
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramUnauthorizedError
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BotCommand

from bot_handlers import Deps, attach_extra_handlers, build_router
from config import load_settings
from database import Database
from fav_watcher import FavoriteWatcher
from vasl_client import VaslClient

log = logging.getLogger("meowtunes")


COMMANDS = [
    BotCommand(command="start", description="منوی اصلی"),
    BotCommand(command="search", description="جستجوی آهنگ / آرتیست / آلبوم"),
    BotCommand(command="connect", description="اتصال اکانت وصل"),
    BotCommand(command="favorites", description="لایک‌های من"),
    BotCommand(command="sync", description="ارسال همه لایک‌ها"),
    BotCommand(command="disconnect", description="قطع اتصال اکانت"),
    BotCommand(command="status", description="وضعیت ربات"),
    BotCommand(command="help", description="راهنما"),
]


async def main() -> int:
    try:
        settings = load_settings()
    except RuntimeError as exc:
        logging.basicConfig(level=logging.INFO)
        log.error("%s", exc)
        return 1

    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    db = Database(settings.database_path)
    await db.connect()

    client = VaslClient(
        api_base=settings.api_base,
        cdn_base=settings.cdn_base,
        timeout=settings.http_timeout,
        max_retries=settings.max_retries,
        max_audio_bytes=settings.max_audio_bytes,
    )

    # Long upload timeout: Telegram send_audio of ~40MB files can take minutes.
    bot_session = AiohttpSession(timeout=300)
    bot = Bot(
        token=settings.bot_token,
        session=bot_session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )

    watcher = FavoriteWatcher(db, client, bot, settings)
    deps = Deps(settings=settings, client=client, db=db, watcher=watcher)

    dispatcher = Dispatcher(storage=MemoryStorage())
    router = build_router(deps)
    attach_extra_handlers(router, deps)
    dispatcher.include_router(router)

    @dispatcher.errors()
    async def on_error(event: object) -> bool:  # pragma: no cover - safety net
        log.exception("unhandled update error")
        return True

    try:
        try:
            me = await bot.get_me()
        except TelegramUnauthorizedError:
            log.error(
                "TELEGRAM_BOT_TOKEN was rejected by Telegram (401 Unauthorized). "
                "Put a valid token from @BotFather in .env."
            )
            return 1
        log.info("bot ready: @%s (id=%s)", me.username, me.id)

        await bot.set_my_commands(COMMANDS)
        watcher.start()

        await dispatcher.start_polling(bot, allowed_updates=["message", "callback_query"])
    finally:
        await watcher.stop()
        await client.aclose()
        await db.close()
        await bot.session.close()
        log.info("shutdown complete")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
