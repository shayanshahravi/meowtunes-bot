"""Async client for the Vasl Social / MeowTunes backend.

Reverse-engineered contract (verified live against https://vasl.social/meowtunes):

  Base API      https://api2.vasl.social/api   (https://vasl.social/api serves the SPA shell)
  Media CDN     https://cdn.v-storage.cloud/<file key>   (public, no auth)

  Public (no login):
    GET  /health
    GET  /music/search?q=&page=&limit=            -> {songs, artists, topArtist, pagination}
    GET  /music/browse?search=&page=&limit=       -> {songs}
    GET  /music/discover
    GET  /music/artists/search?q=&limit=          -> {artists}
    GET  /music/artists/{id|slug}                 -> {artist, popular, albums, allSongsCount}
    GET  /music/artists/{id}/songs?page=&limit=   -> {songs, page, hasMore, total}
    GET  /music/artists/{id}/albums/{albumKey}    -> {album, songs}
    GET  /music/songs-by-artist?name=&page=&limit -> {name, songs, page, hasMore, total}
    GET  /files/{fileId}                          -> full file metadata

  Authenticated (Bearer token, stored in the browser as localStorage["vasl_jwt_token"]):
    GET  /auth/session                            -> {user}
    POST /auth/login {displayName, password, capToken} -> {token, user}
    GET  /music/liked?limit=&page=                -> liked songs
    POST /music/liked/{fileId}                    -> toggle like

Media URLs are built from the file object's `filename` (e.g. "vasls/<user>/<file>.mp3")
or, for older records, a bare filename — both resolve on the CDN.
"""

from __future__ import annotations

import asyncio
import random
import secrets
import string
from dataclasses import dataclass, field
from typing import Any
from collections.abc import Awaitable, Callable
from urllib.parse import quote

import httpx

DEFAULT_API_BASE = "https://api2.vasl.social/api"
DEFAULT_CDN_BASE = "https://cdn.v-storage.cloud"
WEB_ORIGIN = "https://vasl.social"
MEOWTUNES_REFERER = f"{WEB_ORIGIN}/meowtunes"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_TOKEN_CHARS = string.ascii_letters + string.digits + "_-"


# --------------------------------------------------------------------------- errors
class VaslError(Exception):
    """Any failure talking to the Vasl API."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class VaslAuthError(VaslError):
    """Missing / expired / rejected credentials."""


class VaslCaptchaRequired(VaslAuthError):
    """The login endpoint demands a captcha token."""


class VaslNotFound(VaslError):
    """The requested resource does not exist."""


class VaslMediaError(VaslError):
    """The audio payload could not be fetched or is not usable."""


# --------------------------------------------------------------------------- models
def cdn_url(key: str | None, cdn_base: str = DEFAULT_CDN_BASE) -> str | None:
    """Turn a storage key ("vasls/12/a b.mp3") into a public CDN URL."""
    if not key:
        return None
    key = str(key).strip()
    if not key:
        return None
    if key.startswith("http://") or key.startswith("https://"):
        return key
    return f"{cdn_base.rstrip('/')}/{quote(key.lstrip('/'), safe='/')}"


_MIME_EXT = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/x-m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/wav": "wav",
    "audio/webm": "webm",
}


@dataclass(slots=True)
class Track:
    """A MeowTunes audio file, flattened to the fields a player/bot needs."""

    id: str
    title: str
    artist: str | None = None
    album: str | None = None
    duration: int | None = None
    cover_url: str | None = None
    audio_url: str | None = None
    size: int | None = None
    mime_type: str | None = None
    year: str | None = None
    bitrate: int | None = None

    @property
    def display(self) -> str:
        if self.artist:
            return f"{self.title} — {self.artist}"
        return self.title

    @property
    def extension(self) -> str:
        if self.mime_type and self.mime_type in _MIME_EXT:
            return _MIME_EXT[self.mime_type]
        if self.audio_url:
            tail = self.audio_url.rsplit("/", 1)[-1]
            if "." in tail:
                ext = tail.rsplit(".", 1)[-1].lower()
                if 1 <= len(ext) <= 5:
                    return ext
        return "mp3"

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "duration": self.duration,
            "cover_url": self.cover_url,
            "audio_url": self.audio_url,
            "size": self.size,
            "mime_type": self.mime_type,
            "year": self.year,
            "bitrate": self.bitrate,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Track:
        return cls(**{k: data.get(k) for k in cls.__slots__})  # type: ignore[arg-type]

    @classmethod
    def from_song(cls, song: dict[str, Any], cdn_base: str = DEFAULT_CDN_BASE) -> Track:
        meta = song.get("audioMetadata") or {}
        uploader = song.get("uploader") or {}
        key = song.get("filename") or ""
        if not key:
            content_hash = song.get("contentHash") or ""
            key = content_hash if "/" in content_hash else ""
        duration_raw = meta.get("duration")
        duration = None
        if isinstance(duration_raw, (int, float)) and duration_raw > 0:
            duration = int(round(duration_raw))
        bitrate = meta.get("bitrate")
        cover = meta.get("artwork") or song.get("thumbnail")
        return cls(
            id=str(song.get("_id") or song.get("id") or ""),
            title=str(meta.get("title") or song.get("name") or song.get("originalName") or "بدون نام"),
            artist=(str(meta.get("artist")).strip() or None) if meta.get("artist") else (
                str(uploader.get("displayName")).strip() or None if uploader.get("displayName") else None
            ),
            album=(str(meta.get("album")).strip() or None) if meta.get("album") else None,
            duration=duration,
            cover_url=cdn_url(cover, cdn_base),
            audio_url=cdn_url(key, cdn_base),
            size=song.get("size") if isinstance(song.get("size"), int) else None,
            mime_type=song.get("mimeType") or None,
            year=str(meta.get("year")).strip() or None if meta.get("year") else None,
            bitrate=bitrate if isinstance(bitrate, int) else None,
        )


@dataclass(slots=True)
class Artist:
    id: str
    slug: str
    name: str
    image_url: str | None = None
    song_count: int | None = None
    verified: bool = False
    followers: int | None = None

    @property
    def display(self) -> str:
        suffix = f" ({self.song_count} آهنگ)" if self.song_count else ""
        return f"{self.name}{suffix}"

    @classmethod
    def from_api(cls, data: dict[str, Any], cdn_base: str = DEFAULT_CDN_BASE) -> Artist:
        image = data.get("image") or {}
        image_key = image.get("w256") or image.get("w512") or image.get("w96") if isinstance(image, dict) else None
        name = data.get("name") or data.get("nameFa") or data.get("slug") or "آرتیست"
        return cls(
            id=str(data.get("id") or data.get("_id") or ""),
            slug=str(data.get("slug") or data.get("id") or ""),
            name=str(name),
            image_url=cdn_url(image_key, cdn_base),
            song_count=data.get("songs") if isinstance(data.get("songs"), int) else None,
            verified=bool(data.get("verified")),
            followers=data.get("followers") if isinstance(data.get("followers"), int) else None,
        )


@dataclass(slots=True)
class Album:
    """An album reference (from an artist page) or an album found through search."""

    title: str
    artist: str | None = None
    year: str | None = None
    cover_url: str | None = None
    key: str | None = None
    artist_id: str | None = None
    track_count: int | None = None
    tracks: list[Track] = field(default_factory=list)

    @property
    def display(self) -> str:
        parts = [self.title]
        if self.artist:
            parts.append(self.artist)
        if self.track_count:
            parts.append(f"{self.track_count} آهنگ")
        return " — ".join(parts)


def _songs_of(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("songs", "results", "items", "liked", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _liked_song(item: dict[str, Any]) -> dict[str, Any] | None:
    """Liked payloads may wrap the file: {song: {...}, likedAt: ...}."""
    nested = item.get("song") or item.get("file") or item.get("track")
    if isinstance(nested, dict):
        return nested
    if item.get("_id") or item.get("audioMetadata"):
        return item
    return None


# --------------------------------------------------------------------------- client
class VaslClient:
    """One shared HTTP client for every Vasl/MeowTunes call."""

    def __init__(
        self,
        api_base: str = DEFAULT_API_BASE,
        cdn_base: str = DEFAULT_CDN_BASE,
        *,
        timeout: float = 25.0,
        max_retries: int = 3,
        max_audio_bytes: int = 45 * 1024 * 1024,
        token: str | None = None,
        on_token_refresh: Callable[[str], Awaitable[None] | None] | None = None,
    ):
        self.api_base = api_base.rstrip("/")
        self.cdn_base = cdn_base.rstrip("/")
        self.max_retries = max(0, max_retries)
        self.max_audio_bytes = max_audio_bytes
        self.token = token
        self.on_token_refresh = on_token_refresh
        self._visitor_id = self._new_visitor_id()
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0),
            follow_redirects=True,
            headers={
                "User-Agent": USER_AGENT,
                "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
            },
        )

    # -- lifecycle ---------------------------------------------------------
    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> VaslClient:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.aclose()

    @staticmethod
    def _new_visitor_id() -> str:
        """The SPA sends a `vid` matching ^v1\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{16}$."""
        return (
            "v1."
            + "".join(secrets.choice(_TOKEN_CHARS) for _ in range(22))
            + "."
            + "".join(secrets.choice(_TOKEN_CHARS) for _ in range(16))
        )

    def _headers(self, token: str | None, *, json_body: bool = False) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Origin": WEB_ORIGIN,
            "Referer": MEOWTUNES_REFERER,
            "X-Vasl-Visitor": self._visitor_id,
        }
        if json_body:
            headers["Content-Type"] = "application/json"
        effective = token if token is not None else self.token
        if effective:
            headers["Authorization"] = f"Bearer {effective}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any | None = None,
        token: str | None = None,
    ) -> Any:
        url = f"{self.api_base}{path}"
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        clean_params.setdefault("vid", self._visitor_id)

        last_error: VaslError | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._http.request(
                    method,
                    url,
                    params=clean_params,
                    json=json,
                    headers=self._headers(token, json_body=json is not None),
                )
            except httpx.HTTPError as exc:
                last_error = VaslError(f"خطای شبکه: {exc.__class__.__name__}")
                if attempt < self.max_retries:
                    await self._backoff(attempt)
                    continue
                raise last_error from exc

            await self._capture_refreshed_token(response)

            if response.status_code in (429, 500, 502, 503, 504) and attempt < self.max_retries:
                retry_after = response.headers.get("retry-after")
                delay = None
                if retry_after and retry_after.isdigit():
                    delay = min(float(retry_after), 10.0)
                last_error = VaslError(
                    "سرور وصل موقتاً پاسخ نمی‌دهد", status=response.status_code
                )
                await self._backoff(attempt, delay)
                continue

            return self._parse(response)

        raise last_error or VaslError("درخواست به وصل ناموفق بود")

    @staticmethod
    async def _backoff(attempt: int, delay: float | None = None) -> None:
        wait = delay if delay is not None else min(0.7 * (2**attempt) + random.random() * 0.4, 8.0)
        await asyncio.sleep(wait)

    async def _capture_refreshed_token(self, response: httpx.Response) -> None:
        """The API rotates JWTs through the X-New-Token header."""
        new_token = response.headers.get("x-new-token")
        if not new_token or not self.on_token_refresh:
            return
        self.token = new_token
        try:
            result = self.on_token_refresh(new_token)
            if asyncio.iscoroutine(result):
                await result
        except Exception:  # persistence must never break a request
            pass

    def _parse(self, response: httpx.Response) -> Any:
        content_type = response.headers.get("content-type", "")
        if "application/json" not in content_type:
            if response.status_code >= 400:
                raise VaslError(
                    f"پاسخ نامعتبر از سرور (HTTP {response.status_code})",
                    status=response.status_code,
                )
            raise VaslError("پاسخ سرور JSON نبود")

        try:
            data = response.json()
        except ValueError as exc:
            raise VaslError("پاسخ سرور قابل خواندن نبود", status=response.status_code) from exc

        if response.status_code < 400:
            return data

        code = data.get("code") if isinstance(data, dict) else None
        message = data.get("message") if isinstance(data, dict) else None
        text = message or f"HTTP {response.status_code}"

        if code == "CAPTCHA_REQUIRED" or response.status_code == 428:
            raise VaslCaptchaRequired(text, status=response.status_code, code=code)
        if response.status_code in (401, 403):
            raise VaslAuthError(text, status=response.status_code, code=code)
        if response.status_code == 404:
            raise VaslNotFound(text, status=response.status_code, code=code)
        raise VaslError(text, status=response.status_code, code=code)

    # -- public: search ----------------------------------------------------
    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/health")

    async def search_tracks(
        self, query: str, page: int = 1, limit: int = 10
    ) -> dict[str, Any]:
        """Track search. Returns {tracks, artists, total, page}."""
        payload = await self._request(
            "GET", "/music/search", params={"q": query, "page": page, "limit": limit}
        )
        songs = _songs_of(payload)
        pagination = payload.get("pagination") if isinstance(payload, dict) else None
        total = pagination.get("total") if isinstance(pagination, dict) else None
        return {
            "tracks": [Track.from_song(song, self.cdn_base) for song in songs],
            "artists": [Artist.from_api(a, self.cdn_base) for a in (payload.get("artists") or [])]
            if isinstance(payload, dict)
            else [],
            "total": total if isinstance(total, int) else None,
            "page": page,
        }

    async def browse(self, search: str | None = None, page: int = 1, limit: int = 20) -> list[Track]:
        payload = await self._request(
            "GET", "/music/browse", params={"search": search, "page": page, "limit": limit}
        )
        return [Track.from_song(song, self.cdn_base) for song in _songs_of(payload)]

    # -- public: artists ---------------------------------------------------
    async def search_artists(self, query: str, limit: int = 10) -> list[Artist]:
        payload = await self._request(
            "GET", "/music/artists/search", params={"q": query, "limit": limit}
        )
        raw = payload.get("artists") if isinstance(payload, dict) else None
        return [Artist.from_api(a, self.cdn_base) for a in (raw or []) if a.get("slug") or a.get("id")]

    async def get_artist(self, slug_or_id: str) -> dict[str, Any]:
        """Full artist page: {artist, popular, albums, all_songs_count}."""
        payload = await self._request("GET", f"/music/artists/{quote(str(slug_or_id), safe='')}")
        if not isinstance(payload, dict):
            raise VaslNotFound("آرتیست پیدا نشد")
        artist_raw = payload.get("artist") or {}
        artist = Artist.from_api(artist_raw, self.cdn_base) if artist_raw else None
        if artist is None:
            raise VaslNotFound("آرتیست پیدا نشد")

        albums_raw = payload.get("albums") or []
        albums = []
        for entry in albums_raw:
            if not isinstance(entry, dict) or not entry.get("key"):
                continue
            albums.append(
                Album(
                    title=str(entry.get("title") or entry.get("key")),
                    year=str(entry["year"]) if entry.get("year") else None,
                    cover_url=cdn_url(entry.get("artwork"), self.cdn_base),
                    key=str(entry.get("key")),
                    artist_id=artist.id,
                    artist=artist.name,
                    track_count=entry.get("count") if isinstance(entry.get("count"), int) else None,
                )
            )

        popular = [Track.from_song(s, self.cdn_base) for s in (payload.get("popular") or [])]
        return {
            "artist": artist,
            "popular": popular,
            "albums": albums,
            "all_songs_count": payload.get("allSongsCount") or artist.song_count,
        }

    async def get_artist_tracks(
        self, artist_id: str, page: int = 1, limit: int = 50
    ) -> dict[str, Any]:
        """Every track of an artist (artist id, not slug)."""
        payload = await self._request(
            "GET",
            f"/music/artists/{quote(str(artist_id), safe='')}/songs",
            params={"page": page, "limit": limit},
        )
        songs = _songs_of(payload)
        has_more = bool(payload.get("hasMore")) if isinstance(payload, dict) else False
        total = payload.get("total") if isinstance(payload, dict) else None
        return {
            "tracks": [Track.from_song(s, self.cdn_base) for s in songs],
            "has_more": has_more,
            "total": total if isinstance(total, int) else None,
            "page": page,
        }

    async def get_artist_albums(self, slug_or_id: str) -> list[Album]:
        return (await self.get_artist(slug_or_id))["albums"]

    async def get_album_tracks(self, artist_id: str, album_key: str) -> dict[str, Any]:
        """Album tracklist via the artist album route."""
        payload = await self._request(
            "GET",
            f"/music/artists/{quote(str(artist_id), safe='')}/albums/{quote(str(album_key), safe='')}",
        )
        album_raw = payload.get("album") or {} if isinstance(payload, dict) else {}
        songs = _songs_of(payload)
        album = Album(
            title=str(album_raw.get("title") or album_key),
            year=str(album_raw["year"]) if album_raw.get("year") else None,
            cover_url=cdn_url(album_raw.get("artwork"), self.cdn_base),
            key=str(album_raw.get("key") or album_key),
            artist_id=str(artist_id),
            track_count=len(songs),
        )
        return {"album": album, "tracks": [Track.from_song(s, self.cdn_base) for s in songs]}

    # -- public: albums ----------------------------------------------------
    async def search_albums(self, query: str, limit: int = 20, scan: int = 50) -> list[Album]:
        """Album search — the API has no album index, so group matching songs."""
        payload = await self._request(
            "GET", "/music/search", params={"q": query, "limit": scan}
        )
        songs = _songs_of(payload)
        needle = query.strip().casefold()
        groups: dict[tuple[str, str], Album] = {}

        for song in songs:
            track = Track.from_song(song, self.cdn_base)
            if not track.album:
                continue
            key = (track.album.casefold(), (track.artist or "").casefold())
            album = groups.get(key)
            if album is None:
                album = Album(
                    title=track.album,
                    artist=track.artist,
                    year=track.year,
                    cover_url=track.cover_url,
                )
                groups[key] = album
            album.tracks.append(track)
            if album.cover_url is None:
                album.cover_url = track.cover_url

        def rank(album: Album) -> tuple[int, int]:
            title = album.title.casefold()
            if title == needle:
                return (0, -len(album.tracks))
            if needle in title or title in needle:
                return (1, -len(album.tracks))
            return (2, -len(album.tracks))

        albums = sorted(groups.values(), key=rank)
        for album in albums:
            album.track_count = len(album.tracks)
        return albums[:limit]

    async def resolve_album_tracks(
        self,
        album_title: str,
        artist_name: str | None,
        fallback: list[Track] | None = None,
        max_artists: int = 3,
    ) -> list[Track]:
        """Full tracklist for an album discovered through search.

        Search only exposes album *names*, so resolve them to the authoritative
        artist album route: artist search -> artist page -> album key -> tracks.
        """
        fallback = fallback or []
        if not artist_name:
            return fallback

        needle = album_title.strip().casefold()
        wanted_artist = artist_name.strip().casefold()
        try:
            candidates = await self.search_artists(artist_name, limit=5)
        except VaslError:
            return fallback

        checked = 0
        for candidate in candidates:
            if checked >= max_artists:
                break
            if candidate.name.strip().casefold() != wanted_artist:
                continue
            checked += 1
            try:
                profile = await self.get_artist(candidate.slug or candidate.id)
            except VaslError:
                continue
            for album in profile["albums"]:
                if album.title.strip().casefold() != needle or not album.key:
                    continue
                try:
                    result = await self.get_album_tracks(profile["artist"].id, album.key)
                except VaslError:
                    continue
                if result["tracks"]:
                    return result["tracks"]
        return fallback

    # -- public: media -----------------------------------------------------
    async def get_file(self, file_id: str) -> Track:
        payload = await self._request("GET", f"/files/{quote(str(file_id), safe='')}")
        if not isinstance(payload, dict):
            raise VaslNotFound("فایل پیدا نشد")
        track = Track.from_song(payload, self.cdn_base)
        if not track.id:
            track.id = str(file_id)
        if not track.audio_url:
            raise VaslMediaError("لینک مستقیم این آهنگ در دسترس نیست")
        return track

    async def get_track_download_info(self, track_id: str) -> dict[str, Any]:
        """Everything needed to deliver one track: direct URL + full metadata."""
        track = await self.get_file(track_id)
        return {
            "track_id": track.id,
            "title": track.title,
            "artist": track.artist,
            "album": track.album,
            "year": track.year,
            "duration": track.duration,
            "bitrate": track.bitrate,
            "size": track.size,
            "mime_type": track.mime_type,
            "cover_url": track.cover_url,
            "audio_url": track.audio_url,
            "filename": self._filename(track),
        }

    def _filename(self, track: Track) -> str:
        base = f"{track.artist} - {track.title}" if track.artist else track.title
        cleaned = "".join(ch for ch in base if ch not in '\\/:*?"<>|\r\n\t').strip()
        cleaned = cleaned[:80] or "track"
        return f"{cleaned}.{track.extension}"

    async def download_audio(
        self, track_or_id: Track | str, max_bytes: int | None = None
    ) -> tuple[bytes, str]:
        """Fetch the audio bytes from the public CDN."""
        track = track_or_id
        if isinstance(track, str):
            track = await self.get_file(track)
        if not track.audio_url:
            refreshed = await self.get_file(track.id)
            track = refreshed
        if not track.audio_url:
            raise VaslMediaError("لینک دانلود این آهنگ در دسترس نیست")

        limit = max_bytes or self.max_audio_bytes
        if track.size and track.size > limit:
            raise VaslMediaError(
                f"حجم فایل ({track.size // (1024 * 1024)} مگابایت) از حد مجاز تلگرام بیشتر است"
            )

        try:
            async with self._http.stream(
                "GET",
                track.audio_url,
                headers={"Referer": MEOWTUNES_REFERER, "User-Agent": USER_AGENT},
            ) as response:
                if response.status_code != 200:
                    raise VaslMediaError(
                        f"دریافت فایل ناموفق بود (HTTP {response.status_code})",
                        status=response.status_code,
                    )
                content_type = response.headers.get("content-type", "")
                if "text/html" in content_type:
                    raise VaslMediaError("سرور فایل، صفحه وب برگرداند")
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > limit:
                    raise VaslMediaError("حجم فایل از حد مجاز تلگرام بیشتر است")
                buffer = bytearray()
                async for chunk in response.aiter_bytes(64 * 1024):
                    buffer.extend(chunk)
                    if len(buffer) > limit:
                        raise VaslMediaError("حجم فایل از حد مجاز تلگرام بیشتر است")
        except httpx.HTTPError as exc:
            raise VaslMediaError(f"خطای شبکه در دانلود: {exc.__class__.__name__}") from exc

        if not buffer:
            raise VaslMediaError("فایل دریافتی خالی بود")
        return bytes(buffer), content_type or track.mime_type or "audio/mpeg"

    async def fetch_thumbnail(self, url: str | None, max_bytes: int = 200 * 1024) -> bytes | None:
        """Download cover art bytes for Telegram (it requires an upload, not a URL)."""
        if not url:
            return None
        try:
            async with self._http.stream(
                "GET",
                url,
                headers={"Referer": MEOWTUNES_REFERER, "User-Agent": USER_AGENT},
            ) as response:
                if response.status_code != 200:
                    return None
                if "image" not in response.headers.get("content-type", ""):
                    return None
                buffer = bytearray()
                async for chunk in response.aiter_bytes(16 * 1024):
                    buffer.extend(chunk)
                    if len(buffer) > max_bytes:
                        return None
        except httpx.HTTPError:
            return None
        return bytes(buffer) or None

    # -- authenticated -----------------------------------------------------
    async def authenticate(
        self, display_name: str, password: str, cap_token: str | None = None
    ) -> dict[str, Any]:
        """Credential login. Vasl guards /auth/login with a captcha token."""
        body: dict[str, Any] = {"displayName": display_name, "password": password}
        if cap_token:
            body["capToken"] = cap_token
        payload = await self._request("POST", "/auth/login", json=body)
        token = None
        if isinstance(payload, dict):
            token = payload.get("token") or (payload.get("data") or {}).get("token")
        if not token:
            raise VaslAuthError("سرور وصل توکنی برنگرداند")
        return {"token": token, "user": payload.get("user") if isinstance(payload, dict) else None}

    async def validate_token(self, token: str) -> dict[str, Any]:
        """Verify a browser session token and return the profile."""
        payload = await self._request("GET", "/auth/session", token=token)
        user = payload.get("user") if isinstance(payload, dict) else None
        if not isinstance(user, dict) or not user:
            raise VaslAuthError("توکن معتبر نیست")
        return user

    @staticmethod
    def user_id_of(user: dict[str, Any]) -> str | None:
        for key in ("id", "_id", "userId", "vaslUserId"):
            value = user.get(key)
            if value:
                return str(value)
        return None

    @staticmethod
    def display_name_of(user: dict[str, Any]) -> str | None:
        for key in ("displayName", "username", "name", "nameFa"):
            value = user.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    async def get_user_favorites(
        self, token: str, limit: int = 50, page: int = 1
    ) -> list[Track]:
        """The user's liked songs on MeowTunes."""
        payload = await self._request(
            "GET", "/music/liked", params={"limit": limit, "page": page}, token=token
        )
        items = _songs_of(payload)
        tracks: list[Track] = []
        seen: set[str] = set()
        for item in items:
            song = _liked_song(item)
            if song is None:
                continue
            track = Track.from_song(song, self.cdn_base)
            if not track.id or track.id in seen:
                continue
            seen.add(track.id)
            tracks.append(track)
        return tracks
