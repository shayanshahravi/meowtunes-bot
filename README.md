# MeowTunes Telegram Bot

Telegram bot for [Vasl Social → MeowTunes](https://vasl.social/meowtunes): search tracks, artists and
albums, receive the actual audio file in Telegram, and — after linking a Vasl account — get every
track you **like on MeowTunes** pushed to your chat automatically.

The whole API layer was reverse-engineered from the live SPA and verified against production; the
documented contract is below and executable via `test_vasl_api.py`.

---

## Features

**Works with no Vasl account**

- **Track search** by name → inline result list (`Title — Artist`) → direct audio delivery.
- **Artist search** → artist profile (top tracks, albums, total songs) → download individual tracks.
- **Album search** → album tracklist → download one track or the whole album sequentially.
- Free-text search: type anything and pick *Track / Artist / Album* from inline buttons.
- Native Telegram audio (`send_audio`) with `title`, `performer`, `duration` and cover-art thumbnail,
  so tracks appear in Telegram's music player.

**Requires a linked Vasl account**

- `/connect` → paste the `vasl_jwt_token` from your browser session (stored encrypted-at-rest by file
  permissions in SQLite, tied to your Telegram id).
- Background watcher polls `GET /music/liked` every `FAV_POLL_SECONDS` (default 15 s) and instantly
  pushes newly liked tracks with the caption *«❤️ موزیک جدیدی که در وصل (MeowTunes) لایک کردید:»*.
- Existing favorites are **seeded silently** on connect, so only *new* likes are auto-sent; `/sync`
  (or the menu button) sends the backlog on demand.
- `synced_favorites` (PK `telegram_id + track_id`) guarantees a track is never delivered twice.

---

## Quick start

```bash
uv venv .venv --python 3.12
. .venv/bin/activate
uv pip install -r requirements.txt

cp .env.example .env      # add TELEGRAM_BOT_TOKEN from @BotFather
python test_vasl_api.py   # verify the live API from your network
python main.py            # start the bot (long polling)
```

Verify the token and the API without starting the bot:

```bash
python test_vasl_api.py --token "$VASL_JWT_TOKEN"
```

The first run creates `data/meowtunes.sqlite3` (mode `0600`) with the schema below.

### Commands

| Command | Purpose |
| --- | --- |
| `/start`, `/menu` | Main inline menu |
| `/search [query]` | Search, with a filter choice |
| `/connect [token]` | Link a Vasl account (token argument is deleted from chat) |
| `/favorites` | Browse liked tracks |
| `/sync` | Send every not-yet-sent favorite |
| `/disconnect` | Unlink the account |
| `/status` | Connection + API health |

---

## Reverse-engineered API contract (verified 2026-11-15)

Base API: `https://api2.vasl.social/api`
(`https://vasl.social/api` is a catch-all that returns the SPA shell — not the API.)

Public media CDN: `https://cdn.v-storage.cloud/<file key>`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | – | `{status, timestamp, uptime}` |
| GET | `/music/search?q=&page=&limit=` | – | `{songs, artists, topArtist, pagination}` |
| GET | `/music/browse?search=&page=&limit=` | – | `{songs}` — `search` filters |
| GET | `/music/discover` | – | `{songs}` library feed |
| GET | `/music/artists/search?q=&limit=` | – | `{artists:[{id, slug, name, image, songs, …}]}` |
| GET | `/music/artists/{id or slug}` | – | `{artist, popular, albums, allSongsCount}` |
| GET | `/music/artists/{id}/songs?page=&limit=` | – | `{songs, page, hasMore, total}` (needs the **id**) |
| GET | `/music/artists/{id}/albums/{albumKey}` | – | `{album, songs}` |
| GET | `/music/songs-by-artist?name=&page=&limit=` | – | `{songs, hasMore, total}`, max `limit` 50 (name-based index, partial) |
| GET | `/files/{fileId}` | – | Full file metadata |
| GET | `/files/{fileId}/source?slide=0` | Bearer | Server-side stream; the bot uses the CDN instead |
| GET | `/auth/session` | Bearer | `{user:{…, role, isSuperAdmin}}` |
| POST | `/auth/login` | – | `{displayName, password, capToken}` → `{token}` |
| GET | `/music/liked?limit=&page=` | Bearer | Liked tracks |
| POST | `/music/liked/{fileId}` | Bearer | Toggle like |

### Key findings

- **Media is public.** Audio lives at `https://cdn.v-storage.cloud/<filename>`, where `filename` is the
  file object's `filename` field (e.g. `vasls/<uploader>/<ts>-<hash>-title.mp3`, or a bare legacy
  name). Covers are `<audioMetadata.artwork>` (e.g. `artwork/<…>.jpg`). No token, no `vid`, no
  `Referer` required — verified with `200 audio/mpeg`, `200 image/jpeg`.
- **No album index exists.** Album data comes from `artists/{id}` (`albums[]` with `key`) and
  `artists/{id}/albums/{key}`. Album *search* groups `/music/search` results by
  `audioMetadata.album`, then resolves the winner through artist search → artist page → album key,
  falling back to the search-visible tracks.
- **Artist endpoints are split.** Lookup accepts a slug, but the tracklist/album routes require the
  Mongo-style artist `id`; `songs-by-artist?name=` is the name-based alternative.
- **JWT rotation.** Responses can carry `X-New-Token`; the client captures it and persists the
  refreshed token automatically.
- **Visitor id.** The SPA sends `vid` (`v1.<22>.<16>`) on every call; the client generates and sends
  one for parity.
- **Credential login is captcha-gated.** `/auth/login` returns `400 CAPTCHA_REQUIRED` without a
  `capToken` (Cap widget), and `/auth/recovery/start` is guarded the same way. The bot therefore uses
  the browser **session-token injection** path that Vasl itself stores in
  `localStorage["vasl_jwt_token"]`. `VaslClient.authenticate()` is implemented for any deployment that
  can supply a captcha token.

---

## Architecture

| File | Responsibility |
| --- | --- |
| `vasl_client.py` | Async httpx SDK: retries/backoff, visitor id, JWT refresh, public search (track/artist/album), media download, auth & favorites |
| `database.py` | aiosqlite: `users`, `synced_favorites`, short-TTL `cache` for stateless callback data |
| `fav_watcher.py` | 15 s polling worker; seeds on link, dedupes, pushes new likes, handles expired tokens |
| `media.py` | CDN download → `send_audio` with metadata + thumbnail, document fallback |
| `bot_handlers.py` | Persian UI, inline keyboards, FSM for search/connect, pagination |
| `main.py` | Wiring, polling, graceful shutdown |
| `test_vasl_api.py` | Live diagnostics (track/artist/album/audio/cover, optional auth) |

### Schema

```sql
users(telegram_id PK, vasl_user_id, vasl_display_name, vasl_token,
      is_connected, fav_seeded, last_sync_at, created_at, updated_at)
synced_favorites(telegram_id, track_id, sent_at, PRIMARY KEY (telegram_id, track_id))
cache(id PK, kind, payload, created_at)
```

---

## Limits & notes

- Telegram bots can upload files up to **50 MB** (`MAX_AUDIO_MB` enforces a 45 MB ceiling); larger
  tracks are reported with a direct link instead.
- Favorite delivery is polling-based (`/music/liked`), so latency ≈ poll interval; Vasl exposes no
  websocket feed for likes.
- Tokens are stored as-is in SQLite (file mode `0600`). `/disconnect` wipes the token.
- `src/`, `dist/`, `wrangler.toml` and the Jest tests are the earlier Cloudflare Workers MVP; they are
  kept for reference. The Python bot in the repo root is the maintained implementation.
