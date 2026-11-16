import type { WorkerConfig, WorkerLogger } from './env';
import type { TelegramApi } from './telegram';
import { WorkerMeowClient, WorkerMeowError } from './meowtunes';
import type { VaslFile } from '../meowtunes/client';
import { MediaValidator } from './validate';
import { getPendingSearch, putPendingSearch } from './store';

// Reuse the existing TrackResolver contract: VaslFile._id is fileId.
// Pull just these helpers in — no Node imports.
function titleOf(s: VaslFile): string {
  const a: Record<string, unknown> = s as unknown as Record<string, unknown>;
  const meta = (a['audioMetadata'] as Record<string, unknown>) ?? {};
  return String((meta['title'] as string) ?? (a['name'] as string) ?? (a['originalName'] as string) ?? (a['_id'] as string) ?? 'Untitled');
}
function artistOf(s: VaslFile): string | undefined {
  const a = s as unknown as Record<string, unknown>;
  const meta = (a['audioMetadata'] as Record<string, unknown>) ?? {};
  const uploader = (a['uploader'] as Record<string, unknown>) ?? {};
  const v = (meta['artist'] as string) ?? (uploader['displayName'] as string);
  return v ? String(v) : undefined;
}
function albumOf(s: VaslFile): string | undefined {
  const meta = ((s as unknown as Record<string, unknown>)['audioMetadata'] as Record<string, unknown>) ?? {};
  const v = meta['album'] as string | undefined;
  return v ? String(v) : undefined;
}
function resolveFileId(s: VaslFile): string {
  const a = s as unknown as Record<string, unknown>;
  const id = String((a['_id'] as string) ?? (a['id'] as string) ?? '').trim();
  if (!id) throw new WorkerMeowError(`Cannot resolve fileId for "${titleOf(s)}"`, 'FILE_NOT_RESOLVED', undefined, false);
  return id;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeFilename(title: string, fallback: string): string {
  const base = title.replace(/[\x00-\x1f/\\?%*:|"<>]/g, '_').trim().slice(0, 80) || fallback;
  return `${base}.mp3`;
}

export interface BotDeps {
  cfg: WorkerConfig;
  log: WorkerLogger;
  meow: WorkerMeowClient;
  tg: TelegramApi;
}

export async function handleTelegramUpdate(update: Record<string, unknown>, deps: BotDeps): Promise<void> {
  const { cfg, log, meow, tg } = deps;

  // Callback query
  if (update['callback_query']) {
    const cq = update['callback_query'] as Record<string, unknown>;
    const cqId = String(cq['id'] || '');
    const fromUser = (cq['from'] as Record<string, unknown>) ?? {};
    const fromId = Number(fromUser['id'] ?? 0);
    if (fromId !== cfg.ownerUserId) {
      await tg.answerCallbackQuery(cqId, 'Not authorized.');
      return;
    }
    const rawData = String((cq['data'] as string) ?? '');
    const msg = cq['message'] as Record<string, unknown> | undefined;
    const chat = (msg?.['chat'] as Record<string, unknown>) ?? (cq['chat'] as Record<string, unknown>) ?? {};
    const chatId = Number(chat['id'] ?? (msg?.['chat'] as Record<string, unknown>)?.['id']);
    if (!chatId) { await tg.answerCallbackQuery(cqId); return; }

    // playlist selection callback: select:<playlistId> or select:<ownerUserId>:<playlistId>
    if (rawData.startsWith('select:')) {
      const rest = rawData.slice('select:'.length);
      let playlistId: string;
      let ownerUserId: string | null = null;
      const colonIdx = rest.indexOf(':');
      if (colonIdx !== -1) {
        ownerUserId = rest.slice(0, colonIdx);
        playlistId = rest.slice(colonIdx + 1);
      } else {
        playlistId = rest;
      }
      if (!playlistId) { await tg.answerCallbackQuery(cqId, 'Invalid selection.'); return; }
      const msgId = Number(msg?.['message_id'] ?? 0);
      await tg.answerCallbackQuery(cqId);
      try {
        if (msgId) await tg.editMessage(chatId, msgId, `🎵 Loading playlist…`);
      } catch { /* ignore */ }
      await handlePlaylistSelection(chatId, msgId, playlistId, ownerUserId, false, deps);
      return;
    }

    // artist track selection — DISABLED
    if (rawData.startsWith('artist:')) {
      await tg.answerCallbackQuery(cqId, 'Artist search is temporarily disabled.');
      return;
    }

    // song track selection (stateless): song:<fileId> — fileId is the download input
    if (rawData.startsWith('song:')) {
      const fileId = rawData.slice('song:'.length).trim();
      if (!fileId) { await tg.answerCallbackQuery(cqId, 'Invalid selection.'); return; }
      if (!/^[0-9a-f]{24}$/i.test(fileId)) { await tg.answerCallbackQuery(cqId, 'Invalid file id.'); return; }
      await tg.answerCallbackQuery(cqId);
      const msgId = Number(msg?.['message_id'] ?? 0);
      try { if (msgId) await tg.editMessage(chatId, msgId, '🎵 Downloading…'); } catch { /* ignore */ }
      await handleSongSelection(chatId, msgId, fileId, deps);
      return;
    }

    await tg.answerCallbackQuery(cqId, 'Unknown action.');
    return;
  }

  // Message commands
  const msg = update['message'] as Record<string, unknown> | undefined;
  if (!msg) return;
  const fromId = Number(((msg['from'] as Record<string, unknown>)?.['id'] as number) ?? 0);
  const chatId = Number(((msg['chat'] as Record<string, unknown>)?.['id'] as number) ?? 0);
  const text = String((msg['text'] as string) ?? '');
  if (!text || !chatId) return;

  // Owner-only gate — other users get one message and stop (no info leak)
  if (fromId !== cfg.ownerUserId) {
    // Only answer to commands/mentions — ignore random chat to stay quiet
    if (text.startsWith('/')) {
      try {
        await tg.sendMessage(chatId, '❌ This bot is for personal use only.');
      } catch (err) { log.warn('owner-gate reply failed', { error: (err as Error).message }); }
    }
    return;
  }

  if (text.startsWith('/start')) {
    await tg.sendMessage(
      chatId,
      '👋 MeowTunes bot — Cloudflare Workers edition\n\nCommands:\n  /playlist &lt;name&gt; — search &amp; download a playlist\n  /song &lt;name&gt; — search &amp; download a song\n  /ping — check MeowTunes auth\n  /status — not persistent on Workers (see /help)\n  /cancel — cancel is per-request on Workers\n  /help — this help',
    );
    return;
  }
  if (text.startsWith('/help')) {
    await tg.sendMessage(
      chatId,
      '📖 Commands:\n/start — welcome\n/playlist &lt;name&gt; — search &amp; download a playlist\n/song &lt;name&gt; — search &amp; download a song\n/ping — verify MEEWTUNES_BEARER_TOKEN\n/status — shows queue is not persistent on Workers\n/cancel — per-request only',
    );
    return;
  }
  if (text.startsWith('/ping')) {
    try {
      const s = await meow.getSession();
      await tg.sendMessage(chatId, s.ok ? `✅ MeowTunes auth OK\nRole: ${s.role}${s.isSuperAdmin ? ' (super admin)' : ''}\nBase: ${esc(cfg.baseUrl)}` : '❌ MeowTunes auth failed — check MEEWTUNES_BEARER_TOKEN.');
    } catch (err) {
      await tg.sendMessage(chatId, `⚠️ Ping error: ${esc((err as Error).message)}`);
    }
    return;
  }
  if (text.startsWith('/status') || text.startsWith('/cancel')) {
    await tg.sendMessage(chatId, 'ℹ️ On Workers this command is per-request. Queue state is not persistent between webhook calls. Use /playlist or /song to start a download.');
    return;
  }
  if (text.startsWith('/playlist')) {
    const query = text.replace(/^\/playlist(@\w+)?\s*/i, '').trim();
    if (!query) {
      await tg.sendMessage(chatId, 'Usage: /playlist &lt;playlist name&gt;\nExample: /playlist After Hours');
      return;
    }
    await tg.sendMessage(chatId, `🔍 Searching MeowTunes for playlists matching "${esc(query)}"…`);
    try {
      const { playlists } = await meow.searchPlaylists(query);
      if (playlists.length === 0) { await tg.sendMessage(chatId, `🔎 No playlists found for "${esc(query)}".`); return; }
      // Normalize to store-friendly summary
      const rows = playlists.slice(0, 8).map((p: Record<string, unknown>) => ({
        id: String((p['_id'] as string) ?? (p['id'] as string)),
        title: String((p['name'] as string) ?? (p['title'] as string) ?? ''),
        ownerId: String((p['owner'] as Record<string, unknown>)?.['userId'] ?? (p['ownerId'] as string) ?? ''),
        isOwner: Boolean((p['isOwner'] as boolean) ?? ((p['owner'] as Record<string, unknown>)?.['self'] as boolean) ?? false),
        songCount: Number((p['songCount'] as number) ?? (Array.isArray((p as Record<string, unknown>)['songs']) ? ((p as Record<string, unknown>)['songs'] as unknown[]).length : 0)),
        coverUrl: (p['coverUrl'] as string) ?? (p['thumbnail'] as string) ?? undefined,
      })).filter((r) => r.id);
      if (rows.length === 1) {
        await handlePlaylistSelection(chatId, 0, rows[0].id, rows[0].ownerId, rows[0].isOwner, deps);
        return;
      }
      putPendingSearch(chatId, rows);
      const kb = rows.map((r) => {
        const cb = r.ownerId && !r.isOwner ? `select:${r.ownerId}:${r.id}` : `select:${r.id}`;
        return [{ text: `${r.title.slice(0, 48)} (${r.songCount} tracks)`, callback_data: cb }];
      });
      await tg.sendMessageWithKeyboard(chatId, `🔎 Found ${rows.length} playlists. Pick one:\n\n${rows.map((r, i) => `${i + 1}. ${esc(r.title)} — ${r.songCount} tracks`).join('\n')}`, kb);
    } catch (err) {
      log.error('playlist search failed', { error: (err as Error).message, query });
      await tg.sendMessage(chatId, `⚠️ Search failed: ${esc((err as Error).message)}`);
    }
    return;
  }
  if (text.startsWith('/artist')) {
    await tg.sendMessage(chatId, '⚠️ Artist search is temporarily disabled. Use /song to search for tracks instead.');
    return;
  }
  if (text.startsWith('/song')) {
    const query = text.replace(/^\/song(@\w+)?\s*/i, '').trim();
    if (!query) {
      await tg.sendMessage(chatId, 'Usage: /song &lt;song name&gt; [artist]\nExample: /song Lose Yourself Eminem');
      return;
    }
    await tg.sendMessage(chatId, `🔍 Searching MeowTunes for "${esc(query)}"…`);
    try {
      const { songs } = await meow.searchMusic(query, { limit: 8 });
      if (songs.length === 0) { await tg.sendMessage(chatId, `🔎 No tracks found for "${esc(query)}".`); return; }
      const rows = songs
        .map((s: VaslFile, i: number) => {
          const a = s as unknown as Record<string, unknown>;
          const fid = String((a['_id'] as string) ?? (a['id'] as string) ?? '').trim();
          if (!fid) return null;
          const meta = (a['audioMetadata'] as Record<string, unknown>) ?? {};
          return {
            resultId: String(i),
            fileId: fid,
            title: String((meta['title'] as string) ?? (a['name'] as string) ?? 'Untitled'),
            artist: (meta['artist'] as string) ? String(meta['artist']) : undefined,
            album: (meta['album'] as string) ? String(meta['album']) : undefined,
            durationSec: (a['durationSec'] as number) ?? (meta['duration'] as number) ?? undefined,
            coverUrl: (a['thumbnail'] as string) ?? (a['coverUrl'] as string) ?? (meta['artwork'] as string) ?? undefined,
          };
        })
        .filter(Boolean) as Array<{ resultId: string; fileId: string; title: string; artist?: string; album?: string; durationSec?: number; coverUrl?: string }>;
      if (rows.length === 0) { await tg.sendMessage(chatId, `🔎 No usable tracks for "${esc(query)}".`); return; }
      const lines = rows.map((r, i) => `${i + 1}. ${esc(r.title)} — ${esc(r.artist ?? 'Unknown')}`);
      const kb = rows.map((r) => [{ text: `${r.title.slice(0, 32)}${r.title.length > 32 ? '…' : ''} — ${(r.artist ?? '').slice(0, 18)}`, callback_data: `song:${r.fileId}` }]);
      await tg.sendMessageWithKeyboard(chatId, `🎵 ${esc(query)}\n\n${lines.join('\n')}\n\nPick a track to download:`, kb);
    } catch (err) {
      const isAuth = /401|UNAUTHORIZED/i.test((err as Error).message);
      await tg.sendMessage(chatId, isAuth ? '❌ MeowTunes auth failed — check MEEWTUNES_BEARER_TOKEN.' : `⚠️ Search failed: ${esc((err as Error).message)}`);
    }
    return;
  }

  // Unknown command — nudge
  if (text.startsWith('/')) {
    await tg.sendMessage(chatId, 'Unknown command. Try /playlist, /song, /ping, /help.');
  }
}

async function handlePlaylistSelection(chatId: number, msgId: number, playlistId: string, ownerUserId: string | null, isOwner: boolean, deps: BotDeps): Promise<void> {
  const { cfg, log, meow, tg } = deps;
  // Verify the selection was from our search when possible (best-effort).
  void getPendingSearch(chatId);

  let songs: VaslFile[] = [];
  let title = playlistId;
  try {
    const res = ownerUserId && !isOwner
      ? await meow.getPublicPlaylist(ownerUserId, playlistId)
      : await meow.getPlaylist(playlistId);
    title = String((res.playlist['name'] as string) ?? (res.playlist['title'] as string) ?? playlistId);
    songs = res.songs;
  } catch (err) {
    if (msgId) try { await tg.editMessage(chatId, msgId, `❌ Could not load playlist: ${esc((err as Error).message)}`); } catch {}
    else await tg.sendMessage(chatId, `❌ Could not load playlist: ${esc((err as Error).message)}`);
    return;
  }
  if (songs.length === 0) {
    const t = `⚠️ Playlist "${esc(title)}" has no tracks.`;
    if (msgId) try { await tg.editMessage(chatId, msgId, t); } catch { await tg.sendMessage(chatId, t); }
    else await tg.sendMessage(chatId, t);
    return;
  }

  // Cap to avoid hitting Workers subrequest/memory limits
  const cap = Math.min(songs.length, deps.cfg.maxTracksPerPlaylist);
  const slice = songs.slice(0, cap);
  if (slice.length < songs.length) {
    await tg.sendMessage(chatId, `ℹ️ Playlist has ${songs.length} tracks — sending first ${slice.length} (cap MAX_TRACKS_PER_PLAYLIST).`);
  }
  if (msgId) try { await tg.editMessage(chatId, msgId, `⬇️ Downloading ${slice.length} track(s) from "${esc(title)}"…`); } catch {}

  let ok = 0, fail = 0;
  const failures: string[] = [];

  for (let i = 0; i < slice.length; i++) {
    const s = slice[i];
    let fileId: string;
    try { fileId = resolveFileId(s); }
    catch (err) { fail++; failures.push(`${titleOf(s)}: ${esc((err as Error).message)}`); continue; }
    const tTitle = titleOf(s);
    const tArtist = artistOf(s);
    const tAlbum = albumOf(s);
    try {
      const { bytes, contentType } = await meow.getFileSourceBytes(fileId, 0);
      const fn = safeFilename(tTitle, fileId);
      // Light validation — skip tiny non-audio payloads
      try { MediaValidator.validate(bytes, contentType, fn); }
      catch (err) { throw new WorkerMeowError(`Invalid media: ${(err as Error).message}`, 'INVALID_MEDIA', 400, false); }
      const caption = `<b>🎵 ${esc(tTitle)}</b>${tArtist ? `\n👤 ${esc(tArtist)}` : ''}${tAlbum ? `\n💿 ${esc(tAlbum)}` : ''}`;
      try {
        await tg.sendAudio(chatId, bytes, fn, caption, tTitle, tArtist);
      } catch {
        await tg.sendDocument(chatId, bytes, fn, caption);
      }
      ok++;
      log.info('track sent', { idx: i + 1, total: slice.length, title: tTitle });
    } catch (err) {
      log.warn('track failed', { fileId: '[REDACTED]', title: tTitle, error: (err as Error).message });
      fail++;
      failures.push(`${tTitle}: ${esc((err as Error).message)}`);
    }
  }

  const summary = fail === 0
    ? `✅ Playlist "${esc(title)}" complete\nDownloaded: ${ok}/${slice.length}`
    : `✅ Playlist "${esc(title)}" finished with ${fail} failure(s)\nDownloaded: ${ok}/${slice.length}\nFailed: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ''}`;
  if (msgId) try { await tg.editMessage(chatId, msgId, summary); } catch { await tg.sendMessage(chatId, summary); }
  else await tg.sendMessage(chatId, summary);
}

async function handleArtistSelection(
  chatId: number, msgId: number,
  fileId: string,
  deps: BotDeps,
): Promise<void> {
  const { tg, meow, log } = deps;
  try {
    let title = fileId;
    let artist: string | undefined;
    let album: string | undefined;
    try {
      const f = await meow.getFile(fileId);
      const a = f as unknown as Record<string, unknown>;
      const meta = (a['audioMetadata'] as Record<string, unknown>) ?? {};
      title = String((meta['title'] as string) ?? (a['name'] as string) ?? fileId);
      artist = (meta['artist'] as string) ? String(meta['artist']) : undefined;
      album = (meta['album'] as string) ? String(meta['album']) : undefined;
    } catch { /* use fallback title */ }
    const { bytes, contentType } = await meow.getFileSourceBytes(fileId, 0);
    const fn = safeFilename(title, fileId);
    try { MediaValidator.validate(bytes, contentType, fn); }
    catch (err) { throw new WorkerMeowError(`Invalid media: ${(err as Error).message}`, 'INVALID_MEDIA', 400, false); }
    const caption = `<b>🎵 ${esc(title)}</b>${artist ? `
👤 ${esc(artist)}` : ''}${album ? `
💿 ${esc(album)}` : ''}`;
    try { await tg.sendAudio(chatId, bytes, fn, caption, title, artist); }
    catch { await tg.sendDocument(chatId, bytes, fn, caption); }
    const done = `✅ "${esc(title)}" — sent.`;
    if (msgId) try { await tg.editMessage(chatId, msgId, done); } catch { await tg.sendMessage(chatId, done); }
    else await tg.sendMessage(chatId, done);
  } catch (err) {
    log.warn('artist download failed', { fileId: '[REDACTED]', error: (err as Error).message });
    const tt = `❌ Download failed: ${esc((err as Error).message)}`;
    if (msgId) try { await tg.editMessage(chatId, msgId, tt); } catch { await tg.sendMessage(chatId, tt); }
    else await tg.sendMessage(chatId, tt);
  }
}

async function handleSongSelection(
  chatId: number, msgId: number,
  fileId: string,
  deps: BotDeps,
): Promise<void> {
  const { tg, meow, log } = deps;
  try {
    let title = fileId;
    let artist: string | undefined;
    let album: string | undefined;
    try {
      const f = await meow.getFile(fileId);
      const a = f as unknown as Record<string, unknown>;
      const meta = (a['audioMetadata'] as Record<string, unknown>) ?? {};
      title = String((meta['title'] as string) ?? (a['name'] as string) ?? fileId);
      artist = (meta['artist'] as string) ? String(meta['artist']) : undefined;
      album = (meta['album'] as string) ? String(meta['album']) : undefined;
    } catch { /* use fallback title */ }
    const { bytes, contentType } = await meow.getFileSourceBytes(fileId, 0);
    const fn = safeFilename(title, fileId);
    try { MediaValidator.validate(bytes, contentType, fn); }
    catch (err) { throw new WorkerMeowError(`Invalid media: ${(err as Error).message}`, 'INVALID_MEDIA', 400, false); }
    const caption = `<b>🎵 ${esc(title)}</b>${artist ? `\n👤 ${esc(artist)}` : ''}${album ? `\n💿 ${esc(album)}` : ''}`;
    try { await tg.sendAudio(chatId, bytes, fn, caption, title, artist); }
    catch { await tg.sendDocument(chatId, bytes, fn, caption); }
    const done = `✅ "${esc(title)}" — sent.`;
    if (msgId) try { await tg.editMessage(chatId, msgId, done); } catch { await tg.sendMessage(chatId, done); }
    else await tg.sendMessage(chatId, done);
  } catch (err) {
    log.warn('song download failed', { fileId: '[REDACTED]', error: (err as Error).message });
    const is403 = /403|FORBIDDEN|Not permitted/i.test((err as Error).message);
    const tt = is403
      ? '❌ Media playback/download is not available for this account through the supported API.'
      : `❌ Download failed: ${esc((err as Error).message)}`;
    if (msgId) try { await tg.editMessage(chatId, msgId, tt); } catch { await tg.sendMessage(chatId, tt); }
    else await tg.sendMessage(chatId, tt);
  }
}
