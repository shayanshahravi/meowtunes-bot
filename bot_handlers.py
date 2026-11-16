"""Telegram UI: Persian menus, search flows, downloads and account linking."""

from __future__ import annotations

import contextlib
import html
import logging
from collections.abc import Sequence
from dataclasses import dataclass

from aiogram import F, Router
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import Command, CommandStart, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

from config import Settings
from database import Database
from fav_watcher import FavoriteWatcher
from media import send_track, send_tracks
from vasl_client import (
    Album,
    Artist,
    Track,
    VaslAuthError,
    VaslClient,
    VaslError,
)

log = logging.getLogger(__name__)


class Flow(StatesGroup):
    search = State()
    token = State()


@dataclass(slots=True)
class Deps:
    settings: Settings
    client: VaslClient
    db: Database
    watcher: FavoriteWatcher


MENU_TEXT = (
    "🎧 <b>میوتونز | ربات موزیک وصل</b>\n\n"
    "هر آهنگ، آرتیست یا آلبومی که می‌خواهید را همین‌جا پیدا کنید و فایل صوتی‌اش را "
    "مستقیم در تلگرام دریافت کنید — بدون نیاز به حساب وصل.\n\n"
    "اگر اکانت وصل خود را متصل کنید، هر آهنگی که در <b>MeowTunes</b> لایک کنید "
    "به‌صورت خودکار برایتان ارسال می‌شود."
)

CONNECT_TEXT = (
    "🔗 <b>اتصال اکانت وصل</b>\n\n"
    "برای ارسال خودکار لایک‌ها، توکن نشست خود را از مرورگر بردارید:\n\n"
    "<b>روش سریع (بوکمارکلت):</b>\n"
    "۱. روی دکمهٔ «🔗 ورود به وصل» بزنید و در مرورگر لاگین کنید.\n"
    "۲. این کد را یک‌بار به‌عنوان بوکمارک ذخیره کنید و روی صفحهٔ وصل بزنید تا توکن خودکار کپی شود:\n"
    "<code>javascript:(()=>{const t=localStorage.getItem('vasl_jwt_token');if(!t){alert('اول وارد وصل شوید');return;}navigator.clipboard.writeText(t);alert('توکن کپی شد ✅');})()</code>\n"
    "۳. به ربات برگردید و توکن را همین‌جا بفرستید.\n\n"
    "<b>روش دستی:</b> F12 → <b>Application</b> → <b>Local Storage</b> → "
    "<code>https://vasl.social</code> → کلید <code>vasl_jwt_token</code> را کپی کنید.\n\n"
    "⚠️ توکن مثل رمز عبور است؛ پیام حاوی توکن بعد از ذخیره پاک می‌شود. "
    "می‌توانید از <code>/disconnect</code> هم استفاده کنید."
)

FILTER_LABELS = {
    "track": ("🎵 نام آهنگ", "نام آهنگ را بفرستید:"),
    "artist": ("👤 نام آرتیست", "نام آرتیست را بفرستید:"),
    "album": ("💿 نام آلبوم", "نام آلبوم را بفرستید:"),
}


# --------------------------------------------------------------------------- helpers
def esc(value: str | None) -> str:
    return html.escape(value or "", quote=False)


def _short(text: str, limit: int = 60) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def menu_keyboard(connected: bool) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text="🎵 جستجو بر اساس نام آهنگ", callback_data="f:track")],
        [InlineKeyboardButton(text="👤 جستجو بر اساس نام آرتیست", callback_data="f:artist")],
        [InlineKeyboardButton(text="💿 جستجو بر اساس نام آلبوم", callback_data="f:album")],
    ]
    if connected:
        rows.append([InlineKeyboardButton(text="🎧 لایک‌های من در وصل", callback_data="fav:list")])
        rows.append([InlineKeyboardButton(text="🔄 همگام‌سازی همه لایک‌ها", callback_data="fav:all")])
        rows.append([InlineKeyboardButton(text="🔌 قطع اتصال اکانت", callback_data="acc:logout")])
    else:
        rows.append(
            [
                InlineKeyboardButton(
                    text="🔗 اتصال اکانت وصل (ارسال خودکار لایک‌ها)",
                    callback_data="acc:connect",
                )
            ]
        )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _tracks_keyboard(cid: str, tracks: Sequence[Track], page: int, page_size: int) -> InlineKeyboardMarkup:
    start = (page - 1) * page_size
    window = tracks[start : start + page_size]
    rows: list[list[InlineKeyboardButton]] = []
    for offset, track in enumerate(window):
        index = start + offset
        label = f"{index + 1}. {_short(track.title, 34)}"
        if track.artist:
            label += f" — {_short(track.artist, 18)}"
        rows.append([InlineKeyboardButton(text=label, callback_data=f"t:{cid}:{index}")])

    nav: list[InlineKeyboardButton] = []
    if page > 1:
        nav.append(InlineKeyboardButton(text="◀️ قبلی", callback_data=f"pg:{cid}:{page - 1}"))
    if start + page_size < len(tracks):
        nav.append(InlineKeyboardButton(text="بعدی ▶️", callback_data=f"pg:{cid}:{page + 1}"))
    if nav:
        rows.append(nav)
    rows.append(
        [InlineKeyboardButton(text="⬇️ دانلود همه آهنگ‌های این فهرست", callback_data=f"adl:{cid}")]
    )
    rows.append([InlineKeyboardButton(text="🏠 منوی اصلی", callback_data="menu")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


async def _answer(cb: CallbackQuery, text: str | None = None) -> None:
    with contextlib.suppress(TelegramAPIError):
        await cb.answer(text)


async def _show(cb: CallbackQuery, text: str, keyboard: InlineKeyboardMarkup | None) -> None:
    """Edit the callback message when possible, otherwise send a new one."""
    message = cb.message
    if message is not None:
        try:
            await message.edit_text(text, reply_markup=keyboard, disable_web_page_preview=True)
            return
        except TelegramBadRequest:
            pass
        except TelegramAPIError:
            pass
    if message is not None:
        try:
            await message.answer(text, reply_markup=keyboard, disable_web_page_preview=True)
            return
        except TelegramAPIError:
            pass
    if cb.from_user is not None:
        await cb.bot.send_message(
            cb.from_user.id, text, reply_markup=keyboard, disable_web_page_preview=True
        )


async def _render_tracks(
    cb: CallbackQuery,
    deps: Deps,
    *,
    tracks: list[Track],
    title: str,
    page: int = 1,
) -> None:
    if not tracks:
        await _show(cb, "🔎 آهنگی پیدا نشد.", menu_keyboard(False))
        return
    page_size = deps.settings.page_size
    cid = await deps.db.cache_put(
        "tracks", {"tracks": [t.as_dict() for t in tracks], "title": title}
    )
    total_pages = max(1, (len(tracks) + page_size - 1) // page_size)
    header = f"{esc(title)}\n\n{len(tracks)} آهنگ — صفحه {page} از {total_pages}\n\nیکی را برای دریافت انتخاب کنید:"
    await _show(cb, header, _tracks_keyboard(cid, tracks, page, page_size))


async def _send_track_cb(cb: CallbackQuery, deps: Deps, cid: str, index: int) -> None:
    payload = await deps.db.cache_get(cid, "tracks")
    if not payload:
        await _answer(cb, "این فهرست منقضی شده است؛ دوباره جستجو کنید.")
        return
    tracks = [Track.from_dict(item) for item in payload.get("tracks", [])]
    if index < 0 or index >= len(tracks):
        await _answer(cb, "آهنگ پیدا نشد.")
        return
    track = tracks[index]
    await _answer(cb, "⏳ در حال دریافت و ارسال…")
    if cb.from_user is None:
        return
    delivered = await send_track(cb.bot, cb.from_user.id, deps.client, track, deps.settings)
    if delivered:
        log.info("track sent", extra={"track_id": track.id, "telegram_id": cb.from_user.id})


async def _album_download(cb: CallbackQuery, deps: Deps, cid: str) -> None:
    payload = await deps.db.cache_get(cid, "album") or await deps.db.cache_get(cid, "tracks")
    if not payload:
        await _answer(cb, "این فهرست منقضی شده است؛ دوباره جستجو کنید.")
        return
    tracks = [Track.from_dict(item) for item in payload.get("tracks", [])]
    if not tracks:
        await _answer(cb, "آهنگی برای ارسال نیست.")
        return
    await _answer(cb, f"⏳ ارسال {len(tracks)} آهنگ آغاز شد…")
    if cb.from_user is None:
        return
    message = cb.message
    if message is not None:
        try:
            await message.edit_text(f"⬇️ در حال ارسال آلبوم «{esc(payload.get('title'))}»…")
        except TelegramAPIError:
            message = None
    progress = message if message is not None else None
    sent, failed = await send_tracks(
        cb.bot,
        cb.from_user.id,
        deps.client,
        deps.settings,
        tracks,
        progress_message=progress,
    )
    summary = (
        f"✅ آلبوم «{esc(payload.get('title'))}» — {sent} از {len(tracks)} آهنگ ارسال شد"
        + (f"\n❌ ناموفق: {failed}" if failed else "")
    )
    try:
        if progress is not None:
            await progress.edit_text(summary)
        else:
            await cb.bot.send_message(cb.from_user.id, summary)
    except TelegramAPIError:
        pass


# --------------------------------------------------------------------------- router
def build_router(deps: Deps) -> Router:
    router = Router()

    async def _is_connected(telegram_id: int) -> bool:
        user = await deps.db.get_user(telegram_id)
        return bool(user and user.get("is_connected") and user.get("vasl_token"))

    @router.message(CommandStart())
    async def start(message: Message, state: FSMContext) -> None:
        await state.clear()
        connected = await _is_connected(message.from_user.id) if message.from_user else False
        await message.answer(MENU_TEXT, reply_markup=menu_keyboard(connected))

    @router.message(Command("menu"))
    async def menu(message: Message, state: FSMContext) -> None:
        await start(message, state)

    @router.message(Command("help"))
    async def help_command(message: Message) -> None:
        await message.answer(
            "📖 <b>راهنما</b>\n\n"
            "/start — منوی اصلی\n"
            "/search — جستجوی سریع\n"
            "/connect — اتصال اکانت وصل\n"
            "/favorites — لایک‌های من\n"
            "/sync — ارسال همه لایک‌های ارسال‌نشده\n"
            "/disconnect — قطع اتصال اکانت\n"
            "/status — وضعیت ربات و اتصال\n\n"
            "همچنین می‌توانید بدون دستور، نام آهنگ/آرتیست/آلبوم را بنویسید.",
            reply_markup=menu_keyboard(False),
        )

    @router.message(Command("search"))
    async def search_command(message: Message, state: FSMContext) -> None:
        await state.clear()
        query = (message.text or "").replace("/search", "", 1).strip()
        if query:
            await _offer_filters(message, deps, query)
        else:
            await message.answer("🎵 نام آهنگ، آرتیست یا آلبوم را بنویسید:")

    @router.message(Command("status"))
    async def status_command(message: Message) -> None:
        if message.from_user is None:
            return
        user = await deps.db.get_user(message.from_user.id)
        lines = ["⚙️ <b>وضعیت</b>"]
        if user and user.get("is_connected"):
            lines.append(f"🔗 اکانت وصل: <b>{esc(user.get('vasl_display_name') or 'متصل')}</b>")
            lines.append(f"❤️ لایک‌های ثبت‌شده: {await deps.db.favorite_count(message.from_user.id)}")
            lines.append(f"🕒 آخرین بررسی: {esc(user.get('last_sync_at') or '—')}")
        else:
            lines.append("🔓 اکانت وصل متصل نیست (جستجو و دانلود آزاد است).")
        lines.append(f"⏱ بازه بررسی لایک‌ها: هر {deps.settings.fav_poll_seconds} ثانیه")
        try:
            health = await deps.client.health()
            lines.append(f"🌐 API وصل: {esc(str(health.get('status', 'OK')))}")
        except VaslError as exc:
            lines.append(f"⚠️ API وصل در دسترس نیست: {esc(str(exc))}")
        await message.answer("\n".join(lines), reply_markup=menu_keyboard(await _is_connected(message.from_user.id)))

    # -- account linking ---------------------------------------------------
    @router.message(Command("connect"))
    async def connect_command(message: Message, state: FSMContext) -> None:
        if message.from_user is None:
            return
        await state.clear()
        parts = (message.text or "").split(maxsplit=1)
        if len(parts) == 2 and parts[1].strip():
            token = parts[1].strip()
            with contextlib.suppress(TelegramAPIError):
                await message.delete()
            await _complete_connect(message, deps, token)
            return
        await state.set_state(Flow.token)
        await message.answer(
            CONNECT_TEXT,
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text="🔗 ورود به وصل (vasl.social)",
                            url="https://vasl.social/login",
                        )
                    ],
                    [InlineKeyboardButton(text="❌ انصراف", callback_data="menu")],
                ]
            ),
            disable_web_page_preview=True,
        )

    @router.message(Command("disconnect"))
    async def disconnect_command(message: Message, state: FSMContext) -> None:
        if message.from_user is None:
            return
        await state.clear()
        await deps.db.disconnect_user(message.from_user.id)
        await message.answer(
            "🔌 اتصال اکانت وصل قطع شد. جستجو و دانلود همچنان کار می‌کند.",
            reply_markup=menu_keyboard(False),
        )

    @router.message(Flow.token, F.text)
    async def token_received(message: Message, state: FSMContext) -> None:
        if message.from_user is None:
            return
        token = (message.text or "").strip()
        if token.startswith("/"):
            await state.clear()
            return
        with contextlib.suppress(TelegramAPIError):
            await message.delete()
        await state.clear()
        await _complete_connect(message, deps, token)

    # -- favorites ---------------------------------------------------------
    @router.message(Command("favorites"))
    async def favorites_command(message: Message) -> None:
        if message.from_user is None:
            return
        if not await _is_connected(message.from_user.id):
            await message.answer(
                "🔗 برای دیدن لایک‌ها اول اکانت وصل را متصل کنید.",
                reply_markup=menu_keyboard(False),
            )
            return
        try:
            tracks = await deps.watcher.favorite_snapshot(message.from_user.id)
        except VaslAuthError as exc:
            await message.answer(f"⚠️ {esc(str(exc))}")
            return
        except VaslError as exc:
            await message.answer(f"⚠️ خطا در دریافت لایک‌ها: {esc(str(exc))}")
            return
        cid_tracks = tracks
        if not cid_tracks:
            await message.answer("❤️ هنوز آهنگی در MeowTunes لایک نکرده‌اید.")
            return
        page_size = deps.settings.page_size
        cid = await deps.db.cache_put(
            "tracks", {"tracks": [t.as_dict() for t in cid_tracks], "title": "❤️ لایک‌های من در وصل"}
        )
        await message.answer(
            f"❤️ <b>لایک‌های شما</b>\n\n{len(cid_tracks)} آهنگ — یکی را انتخاب کنید:",
            reply_markup=_tracks_keyboard(cid, cid_tracks, 1, page_size),
        )

    @router.message(Command("sync"))
    async def sync_command(message: Message) -> None:
        if message.from_user is None:
            return
        if not await _is_connected(message.from_user.id):
            await message.answer(
                "🔗 برای همگام‌سازی اول اکانت وصل را متصل کنید.",
                reply_markup=menu_keyboard(False),
            )
            return
        notice = await message.answer("🔄 در حال ارسال لایک‌های ارسال‌نشده…")
        try:
            sent, failed = await deps.watcher.sync_all(message.from_user.id)
        except (VaslAuthError, VaslError) as exc:
            await notice.edit_text(f"⚠️ همگام‌سازی ناموفق بود: {esc(str(exc))}")
            return
        await notice.edit_text(
            f"✅ همگام‌سازی تمام شد — {sent} آهنگ ارسال شد"
            + (f"، {failed} ناموفق" if failed else "")
        )

    # -- callbacks ---------------------------------------------------------
    @router.callback_query(F.data == "menu")
    async def menu_cb(cb: CallbackQuery, state: FSMContext) -> None:
        await state.clear()
        await _answer(cb)
        connected = await _is_connected(cb.from_user.id)
        await _show(cb, MENU_TEXT, menu_keyboard(connected))

    @router.callback_query(F.data.startswith("f:"))
    async def filter_cb(cb: CallbackQuery, state: FSMContext) -> None:
        mode = (cb.data or "").split(":", 1)[1]
        if mode not in FILTER_LABELS:
            await _answer(cb, "گزینه نامعتبر.")
            return
        await state.set_state(Flow.search)
        await state.update_data(mode=mode)
        await _answer(cb)
        label, prompt = FILTER_LABELS[mode]
        await _show(
            cb,
            f"{label}\n\n{prompt}\nبرای بازگشت: /menu",
            InlineKeyboardMarkup(
                inline_keyboard=[[InlineKeyboardButton(text="🏠 منوی اصلی", callback_data="menu")]]
            ),
        )

    @router.callback_query(F.data.startswith("acc:"))
    async def account_cb(cb: CallbackQuery, state: FSMContext) -> None:
        action = (cb.data or "").split(":", 1)[1]
        if action == "connect":
            await state.set_state(Flow.token)
            await _answer(cb)
            await _show(
                cb,
                CONNECT_TEXT,
                InlineKeyboardMarkup(
                    inline_keyboard=[
                        [
                            InlineKeyboardButton(
                                text="🔗 ورود به وصل (vasl.social)",
                                url="https://vasl.social/login",
                            )
                        ],
                        [InlineKeyboardButton(text="❌ انصراف", callback_data="menu")],
                    ]
                ),
            )
        elif action == "logout":
            await state.clear()
            await deps.db.disconnect_user(cb.from_user.id)
            await _answer(cb, "اتصال قطع شد.")
            await _show(cb, "🔌 اتصال اکانت قطع شد.", menu_keyboard(False))
        else:
            await _answer(cb, "گزینه نامعتبر.")

    @router.callback_query(F.data == "fav:list")
    async def favorites_cb(cb: CallbackQuery) -> None:
        await _answer(cb, "⏳ در حال دریافت لایک‌ها…")
        try:
            tracks = await deps.watcher.favorite_snapshot(cb.from_user.id)
        except (VaslAuthError, VaslError) as exc:
            await _show(cb, f"⚠️ {esc(str(exc))}", menu_keyboard(False))
            return
        if not tracks:
            await _show(cb, "❤️ هنوز آهنگی لایک نکرده‌اید.", menu_keyboard(True))
            return
        cid = await deps.db.cache_put(
            "tracks", {"tracks": [t.as_dict() for t in tracks], "title": "❤️ لایک‌های من در وصل"}
        )
        await _show(
            cb,
            f"❤️ <b>لایک‌های شما</b>\n\n{len(tracks)} آهنگ — یکی را انتخاب کنید:",
            _tracks_keyboard(cid, tracks, 1, deps.settings.page_size),
        )

    @router.callback_query(F.data == "fav:all")
    async def sync_all_cb(cb: CallbackQuery) -> None:
        await _answer(cb, "⏳ همگام‌سازی آغاز شد…")
        try:
            sent, failed = await deps.watcher.sync_all(cb.from_user.id)
        except (VaslAuthError, VaslError) as exc:
            await _show(cb, f"⚠️ {esc(str(exc))}", menu_keyboard(False))
            return
        await _show(
            cb,
            f"✅ {sent} آهنگ از لایک‌های شما ارسال شد" + (f"، {failed} ناموفق" if failed else ""),
            menu_keyboard(True),
        )

    @router.callback_query(F.data.startswith("t:"))
    async def track_cb(cb: CallbackQuery) -> None:
        _, cid, index = (cb.data or "").split(":", 2)
        try:
            position = int(index)
        except ValueError:
            await _answer(cb, "شناسه نامعتبر.")
            return
        await _send_track_cb(cb, deps, cid, position)

    @router.callback_query(F.data.startswith("pg:"))
    async def page_cb(cb: CallbackQuery) -> None:
        _, cid, page_raw = (cb.data or "").split(":", 2)
        payload = await deps.db.cache_get(cid, "tracks")
        if not payload:
            await _answer(cb, "این فهرست منقضی شده است؛ دوباره جستجو کنید.")
            return
        tracks = [Track.from_dict(item) for item in payload.get("tracks", [])]
        try:
            page = max(1, int(page_raw))
        except ValueError:
            page = 1
        page_size = deps.settings.page_size
        total_pages = max(1, (len(tracks) + page_size - 1) // page_size)
        page = min(page, total_pages)
        await _answer(cb)
        await _show(
            cb,
            f"{esc(payload.get('title'))}\n\n{len(tracks)} آهنگ — صفحه {page} از {total_pages}\n\n"
            "یکی را برای دریافت انتخاب کنید:",
            _tracks_keyboard(cid, tracks, page, page_size),
        )

    @router.callback_query(F.data.startswith("adl:"))
    async def album_download_cb(cb: CallbackQuery) -> None:
        await _album_download(cb, deps, (cb.data or "").split(":", 1)[1])

    @router.callback_query(F.data.startswith("sp:"))
    async def search_page_cb(cb: CallbackQuery) -> None:
        payload = await deps.db.cache_get((cb.data or "").split(":", 1)[1], "search")
        if not payload:
            await _answer(cb, "این جستجو منقضی شده است.")
            return
        await _answer(cb, "⏳ در حال جستجوی صفحه بعد…")
        await _run_search_cb(cb, deps, payload.get("q", ""), payload.get("page", 1) + 1)

    @router.callback_query(F.data.startswith("a:"))
    async def artist_cb(cb: CallbackQuery) -> None:
        _, cid, index = (cb.data or "").split(":", 2)
        payload = await deps.db.cache_get(cid, "artists")
        if not payload:
            await _answer(cb, "این فهرست منقضی شده است؛ دوباره جستجو کنید.")
            return
        artists = payload.get("artists", [])
        try:
            artist_raw = artists[int(index)]
        except (ValueError, IndexError):
            await _answer(cb, "آرتیست پیدا نشد.")
            return
        await _answer(cb, "⏳ در حال دریافت آثار…")
        await _render_artist(cb, deps, Artist.from_api(artist_raw, deps.client.cdn_base))

    @router.callback_query(F.data.startswith("at:"))
    async def artist_tracks_cb(cb: CallbackQuery) -> None:
        _, cid, page_raw = (cb.data or "").split(":", 2)
        payload = await deps.db.cache_get(cid, "artist")
        if not payload:
            await _answer(cb, "اطلاعات آرتیست منقضی شده است.")
            return
        artist_raw = payload.get("artist") or {}
        artist_id = artist_raw.get("id")
        if not artist_id:
            await _answer(cb, "شناسه آرتیست موجود نیست.")
            return
        try:
            page = max(1, int(page_raw))
        except ValueError:
            page = 1
        await _answer(cb, "⏳ در حال دریافت آهنگ‌ها…")
        try:
            result = await deps.client.get_artist_tracks(artist_id, page=page, limit=50)
        except VaslError as exc:
            await _show(cb, f"⚠️ خطا: {esc(str(exc))}", menu_keyboard(False))
            return
        await _render_tracks(
            cb,
            deps,
            tracks=result["tracks"],
            title=f"🎧 {artist_raw.get('name', '')} — همه آهنگ‌ها",
        )

    @router.callback_query(F.data.startswith("al:"))
    async def artist_album_cb(cb: CallbackQuery) -> None:
        _, cid, index = (cb.data or "").split(":", 2)
        payload = await deps.db.cache_get(cid, "artist")
        if not payload:
            await _answer(cb, "اطلاعات آرتیست منقضی شده است.")
            return
        albums = payload.get("albums", [])
        try:
            album_raw = albums[int(index)]
        except (ValueError, IndexError):
            await _answer(cb, "آلبوم پیدا نشد.")
            return
        artist_id = album_raw.get("artist_id") or (payload.get("artist") or {}).get("id")
        key = album_raw.get("key")
        if not artist_id or not key:
            await _answer(cb, "اطلاعات آلبوم ناقص است.")
            return
        await _answer(cb, "⏳ در حال دریافت آلبوم…")
        try:
            result = await deps.client.get_album_tracks(artist_id, key)
        except VaslError as exc:
            await _show(cb, f"⚠️ خطا: {esc(str(exc))}", menu_keyboard(False))
            return
        await _render_album(cb, deps, result["album"], result["tracks"])

    @router.callback_query(F.data.startswith("as:"))
    async def album_search_pick_cb(cb: CallbackQuery) -> None:
        _, cid, index = (cb.data or "").split(":", 2)
        payload = await deps.db.cache_get(cid, "album_search")
        if not payload:
            await _answer(cb, "این فهرست منقضی شده است؛ دوباره جستجو کنید.")
            return
        albums = payload.get("albums", [])
        try:
            album_raw = albums[int(index)]
        except (ValueError, IndexError):
            await _answer(cb, "آلبوم پیدا نشد.")
            return
        album = Album(**{k: album_raw.get(k) for k in Album.__slots__})  # type: ignore[arg-type]
        await _answer(cb, "⏳ در حال دریافت آهنگ‌های آلبوم…")
        from_search = [Track.from_dict(item) for item in album_raw.get("tracks", [])]
        try:
            tracks = await deps.client.resolve_album_tracks(
                album.title, album.artist, fallback=from_search
            )
        except VaslError as exc:
            log.warning("album resolve failed: %s", exc)
            tracks = from_search
        await _render_album(cb, deps, album, tracks)

    # -- free-text search --------------------------------------------------
    @router.message(Flow.search, F.text)
    async def search_input(message: Message, state: FSMContext) -> None:
        data = await state.get_data()
        mode = data.get("mode", "track")
        await state.clear()
        query = (message.text or "").strip()
        if not query or query.startswith("/"):
            return
        if message.from_user is None:
            return
        await _run_search(message, deps, query, mode)

    @router.message(F.text, StateFilter(None))
    async def free_text(message: Message) -> None:
        text = (message.text or "").strip()
        if not text or text.startswith("/"):
            return
        await _offer_filters(message, deps, text)

    return router


# --------------------------------------------------------------------------- flows
async def _offer_filters(message: Message, deps: Deps, query: str) -> None:
    cid = await deps.db.cache_put("query", {"q": query})
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="🎵 آهنگ", callback_data=f"q:{cid}:track"),
                InlineKeyboardButton(text="👤 آرتیست", callback_data=f"q:{cid}:artist"),
                InlineKeyboardButton(text="💿 آلبوم", callback_data=f"q:{cid}:album"),
            ]
        ]
    )
    await message.answer(
        f"🔍 «{esc(query)}» را چگونه جستجو کنم؟", reply_markup=keyboard
    )


async def _complete_connect(message: Message, deps: Deps, token: str) -> None:
    if message.from_user is None:
        return
    if len(token) < 20:
        await message.answer("⚠️ توکن معتبر به نظر نمی‌رسد. دوباره تلاش کنید (/connect).")
        return
    notice = await message.answer("🔄 در حال بررسی توکن…")
    try:
        user = await deps.client.validate_token(token)
    except VaslAuthError:
        await notice.edit_text(
            "❌ توکن پذیرفته نشد. مطمئن شوید مقدار کامل <code>vasl_jwt_token</code> را "
            "کپی کرده‌اید و نشستتان در مرورگر باز است."
        )
        return
    except VaslError as exc:
        await notice.edit_text(f"⚠️ خطا در بررسی توکن: {esc(str(exc))}")
        return

    vasl_user_id = VaslClient.user_id_of(user)
    display_name = VaslClient.display_name_of(user)
    await deps.db.save_connection(
        message.from_user.id,
        vasl_user_id=vasl_user_id,
        display_name=display_name,
        token=token,
    )

    seeded = 0
    try:
        favorites = await deps.client.get_user_favorites(token, limit=50)
        seeded = await deps.db.seed_favorites(message.from_user.id, [t.id for t in favorites])
        await deps.db.mark_fav_seeded(message.from_user.id)
    except VaslError as exc:
        log.warning("initial favorite seed failed: %s", exc)

    await notice.edit_text(
        "✅ <b>اتصال برقرار شد</b>\n\n"
        f"👤 اکانت: <b>{esc(display_name or vasl_user_id or 'وصل')}</b>\n"
        f"❤️ {seeded} لایک فعلی ثبت شد (بدون ارسال).\n\n"
        "از این به بعد هر آهنگی که در MeowTunes لایک کنید، خودکار همین‌جا ارسال می‌شود.\n"
        "برای ارسال لایک‌های قبلی: /sync",
        reply_markup=menu_keyboard(True),
    )


async def _run_search(message: Message, deps: Deps, query: str, mode: str) -> None:
    if message.from_user is None:
        return
    notice = await message.answer(f"🔍 جستجوی «{esc(query)}»…")
    try:
        if mode == "artist":
            artists = await deps.client.search_artists(query, limit=10)
            await _render_artists_message(notice, deps, artists, query)
        elif mode == "album":
            albums = await deps.client.search_albums(query)
            await _render_albums_message(notice, deps, albums, query)
        else:
            result = await deps.client.search_tracks(query, page=1, limit=10)
            await _render_search_message(notice, deps, result["tracks"], query, 1)
    except VaslError as exc:
        await notice.edit_text(f"⚠️ جستجو ناموفق بود: {esc(str(exc))}")


async def _run_search_cb(cb: CallbackQuery, deps: Deps, query: str, page: int) -> None:
    try:
        result = await deps.client.search_tracks(query, page=page, limit=10)
    except VaslError as exc:
        await _show(cb, f"⚠️ جستجو ناموفق بود: {esc(str(exc))}", menu_keyboard(False))
        return
    tracks = result["tracks"]
    tracks_cid = await deps.db.cache_put(
        "tracks", {"tracks": [t.as_dict() for t in tracks], "title": f"نتایج «{query}»"}
    )
    search_cid = await deps.db.cache_put("search", {"q": query, "page": page})
    keyboard = _tracks_keyboard(tracks_cid, tracks, 1, deps.settings.page_size)
    rows = list(keyboard.inline_keyboard)
    more = [InlineKeyboardButton(text="🔎 صفحه بعد", callback_data=f"sp:{search_cid}")]
    rows.insert(len(rows) - 2, more)
    await _show(
        cb,
        f"🎵 نتایج «{esc(query)}» — صفحه {page}\n\n{len(tracks)} آهنگ:",
        InlineKeyboardMarkup(inline_keyboard=rows),
    )


async def _render_search_message(
    notice: Message, deps: Deps, tracks: list[Track], query: str, page: int
) -> None:
    if not tracks:
        await notice.edit_text(
            f"🔎 برای «{esc(query)}» آهنگی پیدا نشد. املای نام را بررسی کنید."
        )
        return
    tracks_cid = await deps.db.cache_put(
        "tracks", {"tracks": [t.as_dict() for t in tracks], "title": f"نتایج «{query}»"}
    )
    search_cid = await deps.db.cache_put("search", {"q": query, "page": page})
    keyboard = _tracks_keyboard(tracks_cid, tracks, 1, deps.settings.page_size)
    rows = list(keyboard.inline_keyboard)
    rows.insert(
        len(rows) - 2,
        [InlineKeyboardButton(text="🔎 صفحه بعد", callback_data=f"sp:{search_cid}")],
    )
    await notice.edit_text(
        f"🎵 نتایج «{esc(query)}»\n\n{len(tracks)} آهنگ — یکی را انتخاب کنید:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
    )


async def _render_artists_message(
    notice: Message, deps: Deps, artists: list[Artist], query: str
) -> None:
    if not artists:
        await notice.edit_text(f"🔎 آرتیستی با نام «{esc(query)}» پیدا نشد.")
        return
    cid = await deps.db.cache_put(
        "artists",
        {
            "artists": [
                {
                    "id": a.id,
                    "slug": a.slug,
                    "name": a.name,
                    "image": {"w256": a.image_url} if a.image_url else {},
                    "songs": a.song_count,
                    "verified": a.verified,
                    "followers": a.followers,
                }
                for a in artists
            ],
            "q": query,
        },
    )
    rows = [
        [
            InlineKeyboardButton(
                text=_short(a.display, 60),
                callback_data=f"a:{cid}:{index}",
            )
        ]
        for index, a in enumerate(artists)
    ]
    rows.append([InlineKeyboardButton(text="🏠 منوی اصلی", callback_data="menu")])
    await notice.edit_text(
        f"👤 آرتیست‌های «{esc(query)}» — یکی را انتخاب کنید:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
    )


async def _render_albums_message(
    notice: Message, deps: Deps, albums: list[Album], query: str
) -> None:
    if not albums:
        await notice.edit_text(f"🔎 آلبومی با نام «{esc(query)}» پیدا نشد.")
        return
    cid = await deps.db.cache_put(
        "album_search",
        {
            "albums": [
                {
                    "title": a.title,
                    "artist": a.artist,
                    "year": a.year,
                    "cover_url": a.cover_url,
                    "key": a.key,
                    "artist_id": a.artist_id,
                    "track_count": a.track_count,
                    "tracks": [t.as_dict() for t in a.tracks],
                }
                for a in albums
            ],
            "q": query,
        },
    )
    rows = [
        [
            InlineKeyboardButton(
                text=_short(
                    f"💿 {a.title}" + (f" — {a.artist}" if a.artist else ""), 60
                ),
                callback_data=f"as:{cid}:{index}",
            )
        ]
        for index, a in enumerate(albums[:12])
    ]
    rows.append([InlineKeyboardButton(text="🏠 منوی اصلی", callback_data="menu")])
    await notice.edit_text(
        f"💿 آلبوم‌های «{esc(query)}» — یکی را انتخاب کنید:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
    )


async def _render_artist(cb: CallbackQuery, deps: Deps, artist: Artist) -> None:
    try:
        profile = await deps.client.get_artist(artist.slug or artist.id)
    except VaslError as exc:
        await _show(cb, f"⚠️ خطا در دریافت آرتیست: {esc(str(exc))}", menu_keyboard(False))
        return

    full_artist: Artist = profile["artist"]
    albums: list[Album] = profile["albums"]
    popular: list[Track] = profile["popular"]
    total = profile.get("all_songs_count") or full_artist.song_count

    cid = await deps.db.cache_put(
        "artist",
        {
            "artist": {
                "id": full_artist.id,
                "slug": full_artist.slug,
                "name": full_artist.name,
                "image": {"w256": full_artist.image_url} if full_artist.image_url else {},
                "songs": full_artist.song_count,
                "verified": full_artist.verified,
            },
            "popular": [t.as_dict() for t in popular],
            "albums": [
                {
                    "title": a.title,
                    "artist": a.artist,
                    "year": a.year,
                    "cover_url": a.cover_url,
                    "key": a.key,
                    "artist_id": a.artist_id,
                    "track_count": a.track_count,
                }
                for a in albums
            ],
        },
    )

    rows: list[list[InlineKeyboardButton]] = []
    for index, track in enumerate(popular[:6]):
        rows.append(
            [
                InlineKeyboardButton(
                    text=_short(f"🎵 {track.title}", 60),
                    callback_data=f"tp:{cid}:{index}",
                )
            ]
        )
    for index, album in enumerate(albums[:8]):
        rows.append(
            [
                InlineKeyboardButton(
                    text=_short(f"💿 {album.title}", 60),
                    callback_data=f"al:{cid}:{index}",
                )
            ]
        )
    rows.append(
        [InlineKeyboardButton(text=f"🎧 همه آهنگ‌ها ({total or '—'})", callback_data=f"at:{cid}:1")]
    )
    rows.append([InlineKeyboardButton(text="🏠 منوی اصلی", callback_data="menu")])

    lines = [f"👤 <b>{esc(full_artist.name)}</b>"]
    if full_artist.verified:
        lines.append("✅ تأییدشده")
    if full_artist.followers:
        lines.append(f"👥 {full_artist.followers} فالوور")
    if total:
        lines.append(f"🎵 {total} آهنگ")
    if albums:
        lines.append(f"💿 {len(albums)} آلبوم")
    lines.append("")
    lines.append("یک آهنگ یا آلبوم را انتخاب کنید:")
    await _show(
        cb,
        "\n".join(lines),
        InlineKeyboardMarkup(inline_keyboard=rows),
    )


# Popular-track buttons on the artist page reuse the "tracks" cache but index
# into the artist payload; register this separately to keep callbacks short.
async def _send_artist_popular(cb: CallbackQuery, deps: Deps, cid: str, index: int) -> None:
    payload = await deps.db.cache_get(cid, "artist")
    if not payload:
        await _answer(cb, "اطلاعات آرتیست منقضی شده است.")
        return
    popular = [Track.from_dict(item) for item in payload.get("popular", [])]
    if index < 0 or index >= len(popular):
        await _answer(cb, "آهنگ پیدا نشد.")
        return
    await _answer(cb, "⏳ در حال ارسال…")
    await send_track(cb.bot, cb.from_user.id, deps.client, popular[index], deps.settings)


async def _render_album(
    cb: CallbackQuery, deps: Deps, album: Album, tracks: list[Track]
) -> None:
    if not tracks:
        await _show(
            cb,
            f"⚠️ برای آلبوم «{esc(album.title)}» آهنگی پیدا نشد.",
            menu_keyboard(False),
        )
        return
    cid = await deps.db.cache_put(
        "album",
        {
            "title": album.title,
            "artist": album.artist,
            "cover_url": album.cover_url,
            "tracks": [t.as_dict() for t in tracks],
        },
    )
    page_size = deps.settings.page_size
    keyboard = _tracks_keyboard(cid, tracks, 1, page_size)
    header = f"💿 <b>{esc(album.title)}</b>"
    if album.artist:
        header += f"\n👤 {esc(album.artist)}"
    header += f"\n\n{len(tracks)} آهنگ — یکی را انتخاب کنید یا کل آلبوم را بگیرید:"
    await _show(cb, header, keyboard)


def attach_extra_handlers(router: Router, deps: Deps) -> None:
    """Callbacks that need the artist-popular payload (kept out of the main router)."""

    @router.callback_query(F.data.startswith("tp:"))
    async def popular_cb(cb: CallbackQuery) -> None:
        _, cid, index = (cb.data or "").split(":", 2)
        try:
            position = int(index)
        except ValueError:
            await _answer(cb, "شناسه نامعتبر.")
            return
        await _send_artist_popular(cb, deps, cid, position)

    @router.callback_query(F.data.startswith("q:"))
    async def query_filter_cb(cb: CallbackQuery, state: FSMContext) -> None:
        _, cid, mode = (cb.data or "").split(":", 2)
        payload = await deps.db.cache_get(cid, "query")
        if not payload:
            await _answer(cb, "این جستجو منقضی شده است.")
            return
        query = payload.get("q", "")
        await state.clear()
        await _answer(cb, "⏳ در حال جستجو…")
        try:
            if mode == "artist":
                artists = await deps.client.search_artists(query, limit=10)
                if not artists:
                    await _show(cb, f"🔎 آرتیستی با نام «{esc(query)}» پیدا نشد.", menu_keyboard(False))
                    return
                await _render_artists_cb(cb, deps, artists, query)
            elif mode == "album":
                albums = await deps.client.search_albums(query)
                if not albums:
                    await _show(cb, f"🔎 آلبومی با نام «{esc(query)}» پیدا نشد.", menu_keyboard(False))
                    return
                await _render_albums_cb(cb, deps, albums, query)
            else:
                result = await deps.client.search_tracks(query, page=1, limit=10)
                tracks = result["tracks"]
                if not tracks:
                    await _show(cb, f"🔎 برای «{esc(query)}» آهنگی پیدا نشد.", menu_keyboard(False))
                    return
                await _render_search_cb(cb, deps, tracks, query, 1)
        except VaslError as exc:
            await _show(cb, f"⚠️ جستجو ناموفق بود: {esc(str(exc))}", menu_keyboard(False))


async def _render_artists_cb(
    cb: CallbackQuery, deps: Deps, artists: list[Artist], query: str
) -> None:
    cid = await deps.db.cache_put(
        "artists",
        {
            "artists": [
                {
                    "id": a.id,
                    "slug": a.slug,
                    "name": a.name,
                    "image": {"w256": a.image_url} if a.image_url else {},
                    "songs": a.song_count,
                    "verified": a.verified,
                    "followers": a.followers,
                }
                for a in artists
            ],
            "q": query,
        },
    )
    rows = [
        [InlineKeyboardButton(text=_short(a.display, 60), callback_data=f"a:{cid}:{i}")]
        for i, a in enumerate(artists)
    ]
    rows.append([InlineKeyboardButton(text="🏠 منوی اصلی", callback_data="menu")])
    await _show(
        cb,
        f"👤 آرتیست‌های «{esc(query)}» — یکی را انتخاب کنید:",
        InlineKeyboardMarkup(inline_keyboard=rows),
    )


async def _render_albums_cb(
    cb: CallbackQuery, deps: Deps, albums: list[Album], query: str
) -> None:
    cid = await deps.db.cache_put(
        "album_search",
        {
            "albums": [
                {
                    "title": a.title,
                    "artist": a.artist,
                    "year": a.year,
                    "cover_url": a.cover_url,
                    "key": a.key,
                    "artist_id": a.artist_id,
                    "track_count": a.track_count,
                    "tracks": [t.as_dict() for t in a.tracks],
                }
                for a in albums
            ],
            "q": query,
        },
    )
    rows = [
        [
            InlineKeyboardButton(
                text=_short(f"💿 {a.title}" + (f" — {a.artist}" if a.artist else ""), 60),
                callback_data=f"as:{cid}:{i}",
            )
        ]
        for i, a in enumerate(albums[:12])
    ]
    rows.append([InlineKeyboardButton(text="🏠 منوی اصلی", callback_data="menu")])
    await _show(
        cb,
        f"💿 آلبوم‌های «{esc(query)}» — یکی را انتخاب کنید:",
        InlineKeyboardMarkup(inline_keyboard=rows),
    )


async def _render_search_cb(
    cb: CallbackQuery, deps: Deps, tracks: list[Track], query: str, page: int
) -> None:
    tracks_cid = await deps.db.cache_put(
        "tracks", {"tracks": [t.as_dict() for t in tracks], "title": f"نتایج «{query}»"}
    )
    search_cid = await deps.db.cache_put("search", {"q": query, "page": page})
    keyboard = _tracks_keyboard(tracks_cid, tracks, 1, deps.settings.page_size)
    rows = list(keyboard.inline_keyboard)
    rows.insert(
        len(rows) - 2,
        [InlineKeyboardButton(text="🔎 صفحه بعد", callback_data=f"sp:{search_cid}")],
    )
    await _show(
        cb,
        f"🎵 نتایج «{esc(query)}»\n\n{len(tracks)} آهنگ — یکی را انتخاب کنید:",
        InlineKeyboardMarkup(inline_keyboard=rows),
    )
