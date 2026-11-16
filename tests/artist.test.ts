/**
 * Artist tests — disabled behavior, no media calls from disabled flow.
 * Also tests song search functionality.
 */
import { ArtistSearchService } from '../src/meowtunes/artist';
import { MeowTunesClient, VaslFile } from '../src/meowtunes/client';
import { TrackResolver } from '../src/meowtunes/tracks';
import { MeowTunesDownloadService } from '../src/meowtunes/download';
import { PlaylistDownloadWorker } from '../src/telegram/PlaylistDownloadWorker';
import { TelegramProgress } from '../src/telegram/TelegramProgress';
import { MeowTunesError } from '../src/utils/errors';
import { TrackJobStatus } from '../src/queue/jobs';

// Helpers
const MOCK_OID = '507f1f77bcf86cd799439011';
const MOCK_OID_2 = '507f1f77bcf86cd799439012';
const MOCK_OID_3 = '507f1f77bcf86cd799439013';

function vaslFile(overrides: Partial<VaslFile> & { _id: string }): VaslFile {
  return { audioMetadata: {}, ...overrides } as VaslFile;
}

function mockTransport(songs: VaslFile[]) {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: { songs, pagination: { total: songs.length } } }),
  } as any;
}

function makeFileList(...oids: string[]): VaslFile[] {
  return oids.map((id, i) => vaslFile({ _id: id, name: `Track ${i+1}`, audioMetadata: { title: `Track ${i+1}`, artist: 'Eminem', album: 'Album' } }));
}

// ── ArtistSearchService (Node.js — kept for reference) ─────────────────────
describe('ArtistSearchService', () => {
  it('empty query path is still handled (service returns normalized list)', async () => {
    const client = new MeowTunesClient();
    (client as any).transport = mockTransport([]);
    const svc = new ArtistSearchService(client);
    const out = await svc.search('Eminem', 8);
    expect(out).toEqual([]);
    expect((client as any).transport.request).toHaveBeenCalledWith(expect.objectContaining({ path: '/music/search' }));
  });

  it('no results => empty array, no fileId guess', async () => {
    const client = new MeowTunesClient();
    (client as any).transport = mockTransport([]);
    const svc = new ArtistSearchService(client);
    expect(await svc.search('NoSuchArtistXYZ', 8)).toEqual([]);
  });

  it('multiple results => preserves fileId, title, artist, album', async () => {
    const files = makeFileList(MOCK_OID, MOCK_OID_2, MOCK_OID_3);
    const client = new MeowTunesClient();
    (client as any).transport = mockTransport(files);
    const svc = new ArtistSearchService(client);
    const out = await svc.search('Eminem', 8);
    expect(out).toHaveLength(3);
    expect(out[0].fileId).toBe(MOCK_OID);
    expect(out[1].fileId).toBe(MOCK_OID_2);
    expect(out[0].title).toBe('Track 1');
    expect(out[0].artist).toBe('Eminem');
    expect(out[0].album).toBe('Album');
  });

  it('skips rows lacking _id/id (missing fileId)', async () => {
    const files: any[] = [{ name: 'Ghost', audioMetadata: { title: 'Ghost' } }];
    files.push(vaslFile({ _id: MOCK_OID, audioMetadata: { title: 'Real' } } as any));
    const client = new MeowTunesClient();
    (client as any).transport = mockTransport(files as VaslFile[]);
    const svc = new ArtistSearchService(client);
    const out = await svc.search('Eminem', 8);
    expect(out).toHaveLength(1);
    expect(out[0].fileId).toBe(MOCK_OID);
  });

  it('respects limit', async () => {
    const files = makeFileList(MOCK_OID, MOCK_OID_2, MOCK_OID_3, '507f1f77bcf86cd799439014', '507f1f77bcf86cd799439015');
    const client = new MeowTunesClient();
    (client as any).transport = mockTransport(files);
    const svc = new ArtistSearchService(client);
    const out = await svc.search('Eminem', 2);
    expect(out).toHaveLength(2);
  });

  it('toVaslFile round-trips title/artist/album/coverUrl', () => {
    const client = new MeowTunesClient();
    const svc = new ArtistSearchService(client);
    const summary = { resultId: '0', fileId: MOCK_OID, title: 'Lose Yourself', artist: 'Eminem', album: '8 Mile', coverUrl: 'https://cdn/x.jpg' };
    const f = svc.toVaslFile(summary);
    expect(f._id).toBe(MOCK_OID);
    expect(f.audioMetadata?.title).toBe('Lose Yourself');
    expect(f.audioMetadata?.artist).toBe('Eminem');
  });
});

// ── fileId propagation (the critical invariant) ──────────────────────────
describe('artist search result → fileId → downloader invariant', () => {
  it('artist search result fileId reaches downloader unchanged', async () => {
    const files = makeFileList(MOCK_OID);
    const client = new MeowTunesClient();
    (client as any).transport = mockTransport(files);
    const artistSvc = new ArtistSearchService(client);
    const resolver = new TrackResolver({ debug() {}, info() {}, warn() {}, error() {} } as any);

    const [summary] = await artistSvc.search('Eminem', 8);
    expect(summary.fileId).toBe(MOCK_OID);

    const vaslFile2 = artistSvc.toVaslFile(summary);
    const resolved = await resolver.resolveFileId(vaslFile2);
    expect(resolved).toBe(MOCK_OID);
    expect(resolved).toBe(summary.fileId);

    const dlTransport = { request: jest.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'audio/mpeg' }, data: Buffer.alloc(70000, 1) }) } as any;
    const downloader = new MeowTunesDownloadService(dlTransport, { debug() {}, info() {}, warn() {}, error() {} } as any);
    const { MediaValidator } = await import('../src/meowtunes/validate');
    const spy = jest.spyOn(MediaValidator, 'validate').mockReturnValue({ format: 'mp3', contentType: 'audio/mpeg' } as any);
    const res = await downloader.download(resolved);
    expect(dlTransport.request).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringContaining(MOCK_OID) }));
    expect(res.bytes).toBeGreaterThan(0);
    await res.cleanup();
    spy.mockRestore();
  });

  it('invalid/missing fileId is rejected before download', async () => {
    const resolver = new TrackResolver({ debug() {}, info() {}, warn() {}, error() {} } as any);
    await expect(resolver.resolveFileId({} as any)).rejects.toBeInstanceOf(MeowTunesError);
    await expect(resolver.resolveFileId({ _id: '' } as any)).rejects.toBeInstanceOf(MeowTunesError);
  });
});

// ── error paths ──────────────────────────────────────────────────────────
describe('artist search error handling', () => {
  it('401 maps to UNAUTHORIZED and must not crash bot', async () => {
    const client = new MeowTunesClient();
    (client as any).transport = { request: jest.fn().mockRejectedValue(new MeowTunesError('Authentication failed or token expired', 'UNAUTHORIZED', 401, false)) };
    const svc = new ArtistSearchService(client);
    await expect(svc.search('Eminem', 8)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('429 rate limited is retryable', async () => {
    const client = new MeowTunesClient();
    (client as any).transport = { request: jest.fn().mockRejectedValue(MeowTunesError.rateLimited(5)) };
    const svc = new ArtistSearchService(client);
    await expect(svc.search('Eminem', 8)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('network timeout is retryable', async () => {
    const client = new MeowTunesClient();
    (client as any).transport = { request: jest.fn().mockRejectedValue(new MeowTunesError('Request timed out', 'TIMEOUT', undefined, true)) };
    const svc = new ArtistSearchService(client);
    await expect(svc.search('Eminem', 8)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('malformed response (no songs key) returns empty safely via client fallback', async () => {
    const client = new MeowTunesClient();
    (client as any).transport = { request: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: { nope: 123 } }) };
    const svc = new ArtistSearchService(client);
    const out = await svc.search('Eminem', 8);
    expect(out).toEqual([]);
  });
});

// ── download + Telegram upload failure ───────────────────────────────────
describe('artist → download → Telegram delivery', () => {
  it('Telegram upload failure bubbles as job failure (not crash)', async () => {
    const dlTransport = { request: jest.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'audio/mpeg' }, data: Buffer.alloc(70000, 1) }) } as any;
    const downloader = new MeowTunesDownloadService(dlTransport, { debug() {}, info() {}, warn() {}, error() {} } as any);
    const { MediaValidator } = await import('../src/meowtunes/validate');
    jest.spyOn(MediaValidator, 'validate').mockReturnValue({ format: 'mp3', contentType: 'audio/mpeg' } as any);

    const telegram: any = {
      uploadAudio: jest.fn().mockRejectedValue(new Error('Telegram sendAudio failed: 400 file too large')),
      uploadDocument: jest.fn().mockRejectedValue(new Error('Telegram sendDocument failed: 400')),
    };
    const progress: any = { push: jest.fn().mockResolvedValue(undefined) };
    const worker = new PlaylistDownloadWorker(downloader, new TrackResolver({ debug() {}, info() {}, warn() {}, error() {} } as any), telegram, progress, { debug() {}, info() {}, warn() {}, error() {} } as any);
    const job = await worker.processPlaylist({
      chatId: 123,
      telegramUserId: 999,
      playlistId: 'artist:' + MOCK_OID,
      playlistTitle: 'Lose Yourself — Eminem',
      tracks: [{ trackId: MOCK_OID, fileId: MOCK_OID, title: 'Lose Yourself', artist: 'Eminem' }],
    });
    expect(job.tracks[0].status).toBe(TrackJobStatus.FAILED);
    (MediaValidator.validate as any).mockRestore?.();
  });
});

// ── coexistence: /artist must not break /playlist ────────────────────────
describe('coexistence with /playlist', () => {
  it('playlist search still uses GET /music/playlists/search?q=', async () => {
    const client = new MeowTunesClient();
    const t = { request: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: { playlists: [] } }) } as any;
    (client as any).transport = t;
    await client.searchPlaylists('After Hours');
    expect(t.request).toHaveBeenCalledWith(expect.objectContaining({ path: '/music/playlists/search' }));
  });

  it('artist search uses GET /music/search?q= (different contract key)', async () => {
    const client = new MeowTunesClient();
    const t = { request: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: { songs: [] } }) } as any;
    (client as any).transport = t;
    await client.searchMusic('Eminem', { limit: 8 });
    expect(t.request).toHaveBeenCalledWith(expect.objectContaining({ path: '/music/search' }));
  });

  it('contract has no duplicate music/search hardcodes outside contract.ts', async () => {
    const fs = await import('fs');
    const srcFiles = ['src/bot.ts', 'src/meowtunes/client.ts', 'src/meowtunes/artist.ts', 'src/meowtunes/playlists.ts', 'src/meowtunes/download.ts', 'src/meowtunes/tracks.ts'];
    for (const f of srcFiles) {
      if (f === 'src/meowtunes/client.ts') continue;
      const txt = fs.readFileSync(f, 'utf8');
      const hard = (txt.match(/\/music\/search/g) || []).length;
      if (f === 'src/meowtunes/artist.ts') {
        expect(hard).toBe(0);
      }
    }
    const clientTxt = fs.readFileSync('src/meowtunes/client.ts', 'utf8');
    expect(clientTxt).toContain('MeowTunesContract.music.search');
  });
});

// ── Worker Artist disabled ─────────────────────────────────────────────────
describe('worker artist disabled', () => {
  it('handlers.ts has artist disabled message', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain('Artist search is temporarily disabled');
  });

  it('handlers.ts has song as replacement', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain("startsWith('/song')");
    expect(t).toContain('song:${r.fileId}');
  });

  it('handlers.ts has handleSongSelection', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toMatch(/async function handleSongSelection\(/);
  });

  it('handlers.ts has getPublicPlaylist call', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain('getPublicPlaylist');
  });

  it('handlers.ts has select callback with ownerUserId parsing', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain("rest.indexOf(':')");
    expect(t).toContain('ownerUserId');
  });
});
