#!/usr/bin/env python3
"""Live diagnostic for the reverse-engineered Vasl / MeowTunes API.

Usage:
    python test_vasl_api.py                 # public checks only
    python test_vasl_api.py --token <jwt>   # also check authenticated favorites
    VASL_JWT_TOKEN=<jwt> python test_vasl_api.py

Exit code 0 means every required public check passed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import traceback
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vasl_client import (  # noqa: E402
    DEFAULT_API_BASE,
    DEFAULT_CDN_BASE,
    Track,
    VaslAuthError,
    VaslClient,
    VaslError,
)

RESULTS: list[dict[str, Any]] = []


def record(name: str, ok: bool, detail: Any = None, required: bool = True) -> None:
    RESULTS.append({"check": name, "ok": ok, "required": required, "detail": detail})
    mark = "PASS" if ok else ("FAIL" if required else "SKIP")
    print(f"[{mark}] {name}" + (f" — {detail}" if detail is not None else ""))


def _audio_magic(head: bytes) -> str | None:
    signatures = {
        b"ID3": "mp3",
        b"\xff\xfb": "mp3",
        b"\xff\xf3": "mp3",
        b"fLaC": "flac",
        b"OggS": "ogg",
        b"RIFF": "wav",
    }
    for magic, name in signatures.items():
        if head.startswith(magic):
            return name
    if head[4:8] == b"ftyp":
        return "m4a/mp4"
    if head[:4] == b"\x1aE\xdf\xa3":
        return "webm"
    return None


async def check_public(client: VaslClient) -> None:
    print(f"\n=== API base: {client.api_base}")
    print(f"=== CDN base: {client.cdn_base}\n")

    health = await client.health()
    record("GET /health", bool(health.get("status")), health.get("status"))

    # 1. track search
    search = await client.search_tracks("hello", limit=5)
    tracks: list[Track] = search["tracks"]
    record(
        "track search returns songs",
        len(tracks) > 0,
        f"{len(tracks)} results, e.g. {tracks[0].display if tracks else '—'}",
    )
    with_audio = [t for t in tracks if t.audio_url]
    record("track search yields direct CDN URLs", len(with_audio) > 0, f"{len(with_audio)}/{len(tracks)}")
    with_meta = [t for t in tracks if t.title and t.artist]
    record("track search yields title+artist metadata", len(with_meta) > 0, f"{len(with_meta)}/{len(tracks)}")

    if tracks:
        first = tracks[0]
        data, content_type = await client.download_audio(first, max_bytes=60 * 1024 * 1024)
        magic = _audio_magic(data[:16])
        record(
            "audio bytes download from CDN",
            len(data) > 100_000 and magic is not None,
            f"{len(data)} bytes, {content_type}, detected={magic}",
        )

    # 2. artist search + tracks + albums
    artists = await client.search_artists("eminem", limit=3)
    record("artist search", len(artists) > 0, artists[0].display if artists else "—")

    if artists:
        artist = artists[0]
        profile = await client.get_artist(artist.slug)
        record(
            "artist profile (popular + albums)",
            len(profile["popular"]) > 0,
            f"{len(profile['popular'])} popular, {len(profile['albums'])} albums",
        )

        artist_tracks = await client.get_artist_tracks(profile["artist"].id, limit=100)
        record(
            "artist tracklist",
            len(artist_tracks["tracks"]) > 0,
            f"{len(artist_tracks['tracks'])} tracks, total={artist_tracks['total']}",
        )

        if profile["albums"]:
            album_ref = profile["albums"][0]
            album_data = await client.get_album_tracks(profile["artist"].id, album_ref.key)
            record(
                "album tracklist (artist album route)",
                len(album_data["tracks"]) > 0,
                f"{album_data['album'].title}: {len(album_data['tracks'])} tracks",
            )

            if album_data["tracks"]:
                track = album_data["tracks"][0]
                info = await client.get_track_download_info(track.id)
                record(
                    "track download info",
                    bool(info["audio_url"]) and bool(info["title"]),
                    f"{info['title']} — {info['artist']} ({info['size']} bytes)",
                )

    # 3. album search
    albums = await client.search_albums("recovery", limit=5)
    record(
        "album search",
        len(albums) > 0,
        albums[0].display if albums else "—",
    )
    if albums:
        # No fallback on purpose: this must resolve through the album route.
        resolved = await client.resolve_album_tracks(
            albums[0].title, albums[0].artist, fallback=[]
        )
        record(
            "album resolve to full tracklist",
            len(resolved) > 0,
            f"{albums[0].title} — {albums[0].artist}: {len(resolved)} tracks",
        )

    # 4. cover art reachable
    cover_candidates = [t for t in tracks if t.cover_url]
    if cover_candidates:
        async with client._http.stream("GET", cover_candidates[0].cover_url) as response:  # noqa: SLF001
            head = b""
            async for chunk in response.aiter_bytes(64):
                head = chunk
                break
            ok = response.status_code == 200 and not head.startswith(b"<")
            record(
                "cover art reachable",
                ok,
                f"HTTP {response.status_code} {response.headers.get('content-type', '')}",
            )
    else:
        record("cover art reachable", False, "no cover URL in search results", required=False)


async def check_auth(client: VaslClient, token: str | None) -> None:
    if not token:
        record("authenticated favorites", False, "no token supplied (--token)", required=False)
        return
    print("\n=== authenticated checks")
    try:
        user = await client.validate_token(token)
    except VaslAuthError as exc:
        record("validate token", False, str(exc))
        return
    record("validate token", True, VaslClient.display_name_of(user) or VaslClient.user_id_of(user))

    favorites = await client.get_user_favorites(token, limit=50)
    record("favorites list", True, f"{len(favorites)} liked tracks")
    if favorites:
        record("favorites carry track ids", all(bool(t.id) for t in favorites), f"e.g. {favorites[0].display}")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Vasl/MeowTunes API diagnostic")
    parser.add_argument("--token", default=os.getenv("VASL_JWT_TOKEN"), help="Vasl JWT session token")
    parser.add_argument("--api-base", default=os.getenv("VASL_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--cdn-base", default=os.getenv("VASL_CDN_BASE", DEFAULT_CDN_BASE))
    parser.add_argument("--json", action="store_true", help="print a JSON report")
    args = parser.parse_args()

    async with VaslClient(api_base=args.api_base, cdn_base=args.cdn_base, timeout=30) as client:
        try:
            await check_public(client)
        except VaslError as exc:
            record("public API reachability", False, str(exc))
            traceback.print_exc()
        except Exception as exc:  # noqa: BLE001
            record("public API reachability", False, f"{exc.__class__.__name__}: {exc}")
            traceback.print_exc()

        try:
            await check_auth(client, args.token)
        except Exception as exc:  # noqa: BLE001
            record("authenticated favorites", False, f"{exc.__class__.__name__}: {exc}")

    required_failures = [r for r in RESULTS if r["required"] and not r["ok"]]
    passed = sum(1 for r in RESULTS if r["ok"] and r["required"])
    total = sum(1 for r in RESULTS if r["required"])

    print(f"\n{passed}/{total} required checks passed")
    if required_failures:
        print("Failed:")
        for failure in required_failures:
            print(f"  - {failure['check']}: {failure['detail']}")

    if args.json:
        print(json.dumps(RESULTS, ensure_ascii=False, indent=2))

    return 0 if not required_failures else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
