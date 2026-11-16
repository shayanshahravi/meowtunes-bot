import { Telegraf, Context } from 'telegraf';
import { config, validateConfig } from './config';
import { logger } from './logging/logger';
import { MeowTunesClient } from './meowtunes/client';
import { PlaylistService } from './meowtunes/playlists';
import { ArtistSearchService } from './meowtunes/artist';
import { TrackResolver } from './meowtunes/tracks';
import { MeowTunesDownloadService } from './meowtunes/download';
import { PlaylistDownloadWorker } from './telegram/PlaylistDownloadWorker';
import { TelegramService } from './telegram/TelegramService';
import { TelegramProgress } from './telegram/TelegramProgress';
import { QueueManager } from './queue/QueueManager';
import { TrackJobStatus } from './queue/jobs';

const cfgErrors = validateConfig();
if (cfgErrors.length > 0) { logger.error('Configuration errors', { errors: cfgErrors }); process.exit(1); }
logger.info('Starting MeowTunes Telegram Bot', { telegramUserId: config.telegram.ownerUserId, meowtunesBaseUrl: config.meowtunes.baseUrl, networkMode: config.networkMode });

const bot = new Telegraf(config.telegram.botToken);
const telegramService = new TelegramService(config.telegram.botToken, logger);
const meowtunesClient = new MeowTunesClient();
const playlistService = new PlaylistService(meowtunesClient);
const artistService = new ArtistSearchService(meowtunesClient);
const trackResolver = new TrackResolver(logger);
const downloader = new MeowTunesDownloadService(meowtunesClient.transport, logger);
const queueManager = new QueueManager(logger);

const progressMap = new Map<number, TelegramProgress>();
const pendingSearches = new Map<number, Array<{ id: string; title: string; ownerId: string; songCount: number; coverUrl?: string }>>();
const artistSessions = new Map<string, Array<import('./meowtunes/artist').ArtistTrackSummary>>();
const activeChat = new Set<number>();

function isOwner(ctx: Context): boolean {
  return ctx.from?.id === config.telegram.ownerUserId;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

bot.start(async (ctx) => {
  if (!isOwner(ctx)) { await ctx.reply('❌ This bot is for personal use only.'); return; }
  await ctx.reply('👋 Welcome! I can download MeowTunes playlists and tracks for you.\n\nCommands:\n  /playlist <name> – search and download a playlist\n  /artist <name> – search tracks by artist/name and download\n  /cancel – cancel the current download (if any)\n  /status – show current queue status\n  /ping – check MeowTunes auth and bot health\n\nExamples:\n  /playlist After Hours\n  /artist Eminem');
});
bot.help((ctx) => {
  if (!isOwner(ctx)) return;
  void ctx.reply('📖 Available commands:\n\n/start – show welcome message\n/playlist <name> – search MeowTunes for a playlist by name, then download it\n/artist <name> – search MeowTunes tracks by artist/name, pick one to download\n/cancel – cancel the currently running download\n/status – show progress of the current download job\n/ping – verify MeowTunes authentication and bot responsiveness\n\nOnly the owner (user ID ' + config.telegram.ownerUserId + ') can use this bot.');
});
bot.command('ping', async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply('🔎 Checking MeowTunes session...');
  try {
    const session = await meowtunesClient.getSession();
    if (session.ok) { await ctx.reply('✅ MeowTunes auth OK\nRole: ' + session.role + '\nSuper admin: ' + (session.isSuperAdmin ? 'yes' : 'no') + '\n\nBot is ready.'); }
    else { await ctx.reply('❌ MeowTunes authentication failed. Check your MEEWTUNES_BEARER_TOKEN.'); }
  } catch (err: any) { logger.error('Ping failed', { error: err.message }); await ctx.reply('⚠️ Error checking session: ' + err.message); }
});
bot.command('cancel', async (ctx) => {
  if (!isOwner(ctx)) return;
  const chatId = ctx.chat?.id; if (!chatId) return;
  if (!activeChat.has(chatId)) { await ctx.reply('ℹ️ No active download to cancel.'); return; }
  activeChat.delete(chatId); const prog = progressMap.get(chatId); if (prog) { prog.reset(); progressMap.delete(chatId); }
  queueManager.cancel(); await ctx.reply('🛑 Cancellation requested. Waiting for current track to finish...');
});
bot.command('status', async (ctx) => {
  if (!isOwner(ctx)) return;
  const chatId = ctx.chat?.id; if (!chatId) return;
  const prog = progressMap.get(chatId); if (!prog) { await ctx.reply('ℹ️ No active download.'); return; }
  const job = queueManager.getStatus(); if (!job) { await ctx.reply('ℹ️ No job tracked.'); return; }
  await ctx.reply('Job ' + job.jobId + '\nStatus: ' + job.status + '\n✅ Completed: ' + job.completedTracks + '/' + job.totalTracks + '\n❌ Failed: ' + job.failedTracks + '\n🚫 Cancelled: ' + job.cancelledTracks);
});
bot.command('playlist', async (ctx) => {
  if (!isOwner(ctx)) return;
  const chatId = ctx.chat?.id; if (!chatId) return;
  const args = ctx.message?.text?.split(' ').slice(1);
  if (!args || args.length === 0) { await ctx.reply('Usage: /playlist <playlist name>\nExample: /playlist After Hours'); return; }
  const query = args.join(' ').trim(); if (query.length === 0) { await ctx.reply('Please provide a playlist name.'); return; }
  if (activeChat.has(chatId)) { await ctx.reply('⚠️ A download is already running. Wait for it to finish or use /cancel.'); return; }
  activeChat.add(chatId); const prog = new TelegramProgress(telegramService, chatId, logger); progressMap.set(chatId, prog);
  await ctx.reply('🔍 Searching MeowTunes for playlists matching "' + escapeHtml(query) + '"...');
  try {
    const searchResult = await playlistService.search(query);
    if (searchResult.length === 0) { await ctx.reply('🔎 No playlists found for "' + escapeHtml(query) + '".'); return; }
    if (searchResult.length === 1) { await handleSelection(ctx, chatId, searchResult[0], prog); }
    else { const keyboard = { inline_keyboard: searchResult.slice(0, 8).map((pl) => [{ text: pl.title + ' (' + pl.songCount + ' tracks)', callback_data: 'select:' + pl.id }]) }; await ctx.reply('🔎 Found ' + searchResult.length + ' playlists. Pick one:', { reply_markup: keyboard }); pendingSearches.set(chatId, searchResult); }
  } catch (err: any) { logger.error('Playlist search failed', { error: err.message, query }); await ctx.reply('⚠️ Search failed: ' + err.message); }
  finally { activeChat.delete(chatId); }
});
bot.command('artist', async (ctx) => {
  if (!isOwner(ctx)) return;
  const chatId = ctx.chat?.id; if (!chatId) return;
  const raw = (ctx.message as any)?.text as string | undefined;
  const query = raw ? raw.replace(/^\/artist(@\w+)?\s*/i, '').trim() : '';
  if (!query) { await ctx.reply('Usage: /artist <artist name>\nExample: /artist Eminem'); return; }
  if (activeChat.has(chatId)) { await ctx.reply('⚠️ A download is already running. Wait for it to finish or use /cancel.'); return; }
  await ctx.reply('🔍 Searching MeowTunes tracks for "' + escapeHtml(query) + '"...');
  try {
    const results = await artistService.search(query, 8);
    if (results.length === 0) { await ctx.reply('🔎 No tracks found for "' + escapeHtml(query) + '".'); return; }
    const sessionId = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    artistSessions.set(sessionId, results);
    setTimeout(() => artistSessions.delete(sessionId), 10 * 60 * 1000).unref?.();
    const lines = results.map((t, i) => `${i + 1}. ${escapeHtml(t.title)} — ${escapeHtml(t.artist ?? 'Unknown')}`);
    const keyboard = { inline_keyboard: results.map((t) => [{ text: `${t.title.slice(0, 32)}${t.title.length > 32 ? '…' : ''} — ${(t.artist ?? '').slice(0, 18)}`, callback_data: `artist:${sessionId}:${t.resultId}` }]) };
    await ctx.reply('🎵 ' + escapeHtml(query) + '\n\n' + lines.join('\n') + '\n\nPick a track to download:', { reply_markup: keyboard });
  } catch (err: any) {
    logger.error('Artist search failed', { error: err.message, query });
    const msg = /401|UNAUTHORIZED/i.test(err.message) ? '❌ MeowTunes authentication failed. Check your MEEWTUNES_BEARER_TOKEN.' : '⚠️ Search failed: ' + err.message;
    await ctx.reply(msg);
  }
});
bot.action(/^select:(.+)/, async (ctx) => {
  if (!isOwner(ctx)) return; await ctx.answerCbQuery();
  const chatId = ctx.chat?.id; if (!chatId) return;
  const playlistId = ctx.match[1]; const results = pendingSearches.get(chatId);
  const playlist = results?.find((p) => p.id === playlistId);
  if (!playlist) { await ctx.editMessageText('❌ Playlist not found (may have expired). Try /playlist again.'); return; }
  await handleSelection(ctx, chatId, playlist, progressMap.get(chatId)!);
});
bot.action(/^artist:([^:]+):(.+)/, async (ctx) => {
  if (!isOwner(ctx)) return; await ctx.answerCbQuery();
  const chatId = ctx.chat?.id; if (!chatId) return;
  const sessionId = ctx.match[1]; const resultId = ctx.match[2];
  const tracks = artistSessions.get(sessionId);
  if (!tracks) { await ctx.editMessageText('❌ Search expired. Try /artist again.'); return; }
  const chosen = tracks.find((t) => t.resultId === resultId);
  if (!chosen) { await ctx.editMessageText('❌ Track not found (may have expired). Try /artist again.'); return; }
  if (activeChat.has(chatId)) { await ctx.reply('⚠️ A download is already running. Wait for it to finish or use /cancel.'); return; }
  activeChat.add(chatId);
  const prog = progressMap.get(chatId) ?? new TelegramProgress(telegramService, chatId, logger);
  if (!progressMap.has(chatId)) progressMap.set(chatId, prog);
  try { await ctx.editMessageText('🎵 Downloading "' + escapeHtml(chosen.title) + '" — ' + escapeHtml(chosen.artist ?? '')); } catch {}
  await handleArtistSelection(ctx, chatId, chosen, prog);
  activeChat.delete(chatId);
});
async function handleSelection(ctx: Context, chatId: number, playlist: { id: string; title: string; ownerId: string; songCount: number; coverUrl?: string }, prog: TelegramProgress): Promise<void> {
  await prog.push({ jobId: 'starting', telegramUserId: config.telegram.ownerUserId, playlistId: playlist.id, playlistTitle: playlist.title, totalTracks: 0, completedTracks: 0, failedTracks: 0, cancelledTracks: 0, status: TrackJobStatus.QUEUED, tracks: [] }, null);
  try { await ctx.editMessageText('🎵 Loading playlist "' + escapeHtml(playlist.title) + '"...'); } catch {}
  const { playlistId, songs } = await playlistService.resolve(playlist.id);
  if (!songs || songs.length === 0) { await ctx.reply('⚠️ Playlist "' + escapeHtml(playlist.title) + '" has no tracks.'); return; }
  const tracksWithFileId: Array<{ trackId: string; fileId: string; title: string; artist?: string; album?: string }> = [];
  for (const song of songs) {
    try { const fileId = await trackResolver.resolveFileId(song as any); const title = trackResolver.titleOf(song as any); tracksWithFileId.push({ trackId: fileId, fileId, title, artist: trackResolver.artistOf(song as any), album: trackResolver.albumOf(song as any) }); }
    catch (err: any) { const t = trackResolver.titleOf(song as any); logger.warn('Skipping track ' + t + ': cannot resolve fileId', { error: (err as Error).message }); }
  }
  if (tracksWithFileId.length === 0) { await ctx.reply('⚠️ Could not resolve any fileIds for playlist "' + escapeHtml(playlist.title) + '".'); return; }
  prog.push({ jobId: 'job_' + Date.now(), telegramUserId: config.telegram.ownerUserId, playlistId, playlistTitle: playlist.title, totalTracks: tracksWithFileId.length, completedTracks: 0, failedTracks: 0, cancelledTracks: 0, status: TrackJobStatus.QUEUED, tracks: [] }, null);
  const worker = new PlaylistDownloadWorker(downloader, trackResolver, telegramService, prog, logger);
  const job = await worker.processPlaylist({ chatId, telegramUserId: config.telegram.ownerUserId, playlistId, playlistTitle: playlist.title, tracks: tracksWithFileId });
  await prog.push(job, null);
  const failed = job.failedTracks; const completed = job.completedTracks;
  const text = failed === 0 ? '✅ Playlist "' + escapeHtml(playlist.title) + '" complete\nDownloaded: ' + completed + '/' + job.totalTracks : '✅ Playlist "' + escapeHtml(playlist.title) + '" finished with ' + failed + ' failure(s)\nDownloaded: ' + completed + '/' + job.totalTracks + '\nFailed tracks: ' + job.tracks.filter((t) => t.status === TrackJobStatus.FAILED).map((t) => t.title).join(', ');
  try { await ctx.editMessageText(text); } catch { await ctx.reply(text); }
  progressMap.delete(chatId); activeChat.delete(chatId);
}
async function handleArtistSelection(ctx: Context, chatId: number, chosen: import('./meowtunes/artist').ArtistTrackSummary, prog: TelegramProgress): Promise<void> {
  const vaslFile = artistService.toVaslFile(chosen);
  let fileId: string;
  try { fileId = await trackResolver.resolveFileId(vaslFile as any); }
  catch (err: any) { await ctx.reply('⚠️ Could not resolve fileId for "' + escapeHtml(chosen.title) + '": ' + err.message); return; }
  if (fileId !== chosen.fileId) { logger.error('fileId mismatch', { chosenFileId: '[REDACTED]', resolvedFileId: '[REDACTED]' }); await ctx.reply('⚠️ Internal fileId mismatch. Aborted.'); return; }
  const single = [{ trackId: fileId, fileId, title: chosen.title, artist: chosen.artist, album: chosen.album }];
  await prog.push({ jobId: 'artist_starting', telegramUserId: config.telegram.ownerUserId, playlistId: 'artist:' + fileId, playlistTitle: chosen.title, totalTracks: 1, completedTracks: 0, failedTracks: 0, cancelledTracks: 0, status: TrackJobStatus.QUEUED, tracks: [] }, null);
  const worker = new PlaylistDownloadWorker(downloader, trackResolver, telegramService, prog, logger);
  const job = await worker.processPlaylist({ chatId, telegramUserId: config.telegram.ownerUserId, playlistId: 'artist:' + fileId, playlistTitle: chosen.title + (chosen.artist ? ' — ' + chosen.artist : ''), tracks: single });
  await prog.push(job, null);
  const t = job.tracks[0];
  if (t && t.status === TrackJobStatus.FAILED) { await ctx.reply('❌ Download failed for "' + escapeHtml(chosen.title) + '": ' + (t.error ?? 'unknown error')); }
  else if (job.completedTracks === 1) { try { await ctx.editMessageText('✅ "' + escapeHtml(chosen.title) + '" — sent.'); } catch { await ctx.reply('✅ "' + escapeHtml(chosen.title) + '" — sent.'); } }
  progressMap.delete(chatId);
}
bot.catch((err, ctx) => { logger.error('Telegraf error', { error: (err as Error).message, update: ctx.updateType }); if (isOwner(ctx)) { ctx.reply('⚠️ Internal error: ' + (err as Error).message).catch(() => {}); } });
process.once('SIGINT', () => { logger.info('SIGINT received, stopping bot...'); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { logger.info('SIGTERM received, stopping bot...'); bot.stop('SIGTERM'); });
export default bot;
export { artistSessions, pendingSearches, activeChat, progressMap, artistService, playlistService, trackResolver, meowtunesClient };
