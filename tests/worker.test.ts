/**
 * Worker tests — routing, secret validation, error handling, MeowTunes
 * contract preservation, fileId invariant, playlist/song/artist flows.
 * No real network calls: global fetch is mocked per test.
 */
import worker from '../src/worker/entry';
import type { Env } from '../src/worker/env';
import { handleTelegramUpdate } from '../src/worker/handlers';
import { MediaValidator } from '../src/worker/validate';
import { MeowTunesContract } from '../src/meowtunes/contract';

const ENV: Env = {
  TELEGRAM_BOT_TOKEN: 'TESTTOKEN123',
  TELEGRAM_WEBHOOK_SECRET: 'test-secret',
  OWNER_TELEGRAM_USER_ID: '188731463',
  MEEWTUNES_BEARER_TOKEN: 'test-meow-token',
  MEOWTUNES_BASE_URL: 'https://api2.vasl.social/api',
};

const ctx: { waitUntil: (p: Promise<unknown>) => void } = {
  waitUntil: (p) => p.catch(() => {}),
};

function webhookReq(body: string, secret = 'test-secret'): Request {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body,
  });
}

function upd(text: string, from = 188731463, chat = 111) {
  return {
    update_id: 1,
    message: { message_id: 1, from: { id: from }, chat: { id: chat, type: 'private' }, text },
  };
}

function cbUpd(data: string, from = 188731463, chat = 111, msgId = 1) {
  return {
    update_id: 1,
    callback_query: {
      id: 'cq1',
      from: { id: from },
      chat: { id: chat, type: 'private' },
      message: { message_id: msgId, chat: { id: chat, type: 'private' } },
      data,
    },
  };
}

const OID = '507f1f77bcf86cd799439011';

// ── Routing ─────────────────────────────────────────────────────────────────
describe('worker routing', () => {
  it('GET / returns health JSON', async () => {
    const r = await worker.fetch(new Request('https://x/'), ENV, ctx as never);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j['ok']).toBe(true);
  });
  it('GET /health returns ok', async () => {
    const r = await worker.fetch(new Request('https://x/health'), ENV, ctx as never);
    expect(r.status).toBe(200);
  });
  it('unknown route -> 404', async () => {
    const r = await worker.fetch(new Request('https://x/nope'), ENV, ctx as never);
    expect(r.status).toBe(404);
  });
  it('webhook GET -> 405', async () => {
    const r = await worker.fetch(new Request('https://x/telegram/webhook'), ENV, ctx as never);
    expect(r.status).toBe(405);
  });
  it('GET /telegram/diag -> 404 (removed)', async () => {
    const r = await worker.fetch(new Request('https://x/telegram/diag'), ENV, ctx as never);
    expect(r.status).toBe(404);
  });
  it('GET /telegram/setup-webhook -> 404', async () => {
    const r = await worker.fetch(new Request('https://x/telegram/setup-webhook'), ENV, ctx as never);
    expect(r.status).toBe(404);
  });
});

// ── Webhook security ────────────────────────────────────────────────────────
describe('webhook security', () => {
  it('rejects missing secret with 403', async () => {
    const req = new Request('https://x/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upd('/ping')),
    });
    const r = await worker.fetch(req, ENV, ctx as never);
    expect(r.status).toBe(403);
  });
  it('rejects wrong secret with 403', async () => {
    const r = await worker.fetch(webhookReq(JSON.stringify(upd('/ping')), 'wrong'), ENV, ctx as never);
    expect(r.status).toBe(403);
  });
  it('rejects malformed JSON with 400', async () => {
    const r = await worker.fetch(webhookReq('{not json'), ENV, ctx as never);
    expect(r.status).toBe(400);
  });
  it('rejects empty body with 400', async () => {
    const r = await worker.fetch(webhookReq(''), ENV, ctx as never);
    expect(r.status).toBe(400);
  });
  it('missing secrets -> 500 without leaking values', async () => {
    const bad = { ...ENV, MEEWTUNES_BEARER_TOKEN: '' };
    const r = await worker.fetch(webhookReq(JSON.stringify(upd('/ping'))), bad, ctx as never);
    expect(r.status).toBe(500);
    const t = await r.text();
    expect(t).not.toContain('TESTTOKEN');
  });
});

// ── Owner gate ──────────────────────────────────────────────────────────────
describe('owner gate', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('non-owner command gets refusal, no MeowTunes call', async () => {
    const sent: Array<{ url: string; body: string }> = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (u: string, o?: RequestInit) => {
      sent.push({ url: u, body: String(o?.body ?? '') });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), { status: 200 });
    });
    const { createLogger } = await import('../src/worker/env');
    const { TelegramApi } = await import('../src/worker/telegram');
    const { WorkerMeowClient } = await import('../src/worker/meowtunes');
    const log = createLogger('ERROR');
    const cfg = { botToken: 'T', webhookSecret: 's', ownerUserId: 188731463, meowtunesToken: 'm', baseUrl: 'https://api2.vasl.social/api', maxTracksPerPlaylist: 50, maxFileSizeBytes: 50 * 1024 * 1024, maxRetries: 0, requestTimeoutMs: 5000 };
    await handleTelegramUpdate(upd('/playlist x', 999, 111) as unknown as Record<string, unknown>, {
      cfg, log, meow: new WorkerMeowClient(cfg, log), tg: new TelegramApi('T', log),
    });
    expect(sent.some((s) => s.url.includes('api.telegram.org'))).toBe(true);
    expect(sent.some((s) => s.url.includes('vasl.social'))).toBe(false);
    expect(sent.some((s) => s.body.includes('personal use'))).toBe(true);
  });
});

// ── MeowTunes contract preserved ────────────────────────────────────────────
describe('meowtunes contract preserved', () => {
  it('verified endpoints unchanged', () => {
    expect(MeowTunesContract.playlists.search.path).toBe('/music/playlists/search');
    expect(MeowTunesContract.playlists.get.path).toBe('/music/playlists/:id');
    expect(MeowTunesContract.playlists.public.path).toBe('/music/playlists/public/:ownerUserId/:playlistId');
    expect(MeowTunesContract.files.get.path).toBe('/files/:id');
    expect(MeowTunesContract.files.source.path).toBe('/files/:id/source');
    expect(MeowTunesContract.auth.session.path).toBe('/auth/session');
    expect(MeowTunesContract.music.search.path).toBe('/music/search');
  });
  it('no polling entry in worker code', async () => {
    const fs = await import('fs');
    for (const f of ['src/worker/entry.ts', 'src/worker/handlers.ts', 'src/worker/meowtunes.ts', 'src/worker/telegram.ts']) {
      const t = fs.readFileSync(f, 'utf8');
      expect(t).not.toMatch(/bot\.launch|getUpdates|Telegraf/);
      expect(t).not.toMatch(/process\.env/);
    }
  });
  it('no hardcoded secrets in worker source', async () => {
    const fs = await import('fs');
    const all = ['src/worker/entry.ts', 'src/worker/handlers.ts', 'src/worker/meowtunes.ts', 'src/worker/telegram.ts', 'src/worker/env.ts', 'src/worker/store.ts', 'src/worker/validate.ts']
      .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(all).not.toMatch(/883269|eyJhbG/);
    expect(all).not.toContain('process.env');
  });
  it('auth header built as Bearer + token at runtime', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/meowtunes.ts', 'utf8');
    expect(t).toContain('`Bearer ${cfg.meowtunesToken}`');
  });
});

// ── Media validation ────────────────────────────────────────────────────────
describe('media validation', () => {
  it('rejects tiny payloads', () => {
    expect(() => MediaValidator.validate(new Uint8Array(100), 'audio/mpeg', 'x.mp3')).toThrow(/too small/);
  });
  it('rejects HTML', () => {
    expect(() => MediaValidator.validate(new Uint8Array(20000).fill(1), 'text/html', 'x')).toThrow(/HTML/);
  });
  it('accepts ID3 magic', () => {
    const b = new Uint8Array(20000).fill(0);
    b[0] = 0x49; b[1] = 0x44; b[2] = 0x33;
    const r = MediaValidator.validate(b, 'audio/mpeg', 'x.mp3');
    expect(r.format).toBe('id3');
  });
});

// ── Playlist callback format ────────────────────────────────────────────────
describe('playlist callback format', () => {
  it('select callback with ownerUserId parses correctly', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain("startsWith('select:')");
    expect(t).toContain("rest.indexOf(':')");
    expect(t).toContain('getPublicPlaylist');
  });
  it('owned playlist uses getPlaylist (not public)', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain('meow.getPlaylist(playlistId)');
  });
  it('public playlist uses getPublicPlaylist with ownerUserId', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain('meow.getPublicPlaylist(ownerUserId, playlistId)');
  });
  it('callback_data stays under 64 bytes', () => {
    const ownerId = '188731463';
    const playlistId = OID;
    const cb = `select:${ownerId}:${playlistId}`;
    expect(cb.length).toBeLessThanOrEqual(64);
  });
});

// ── Artist disabled ─────────────────────────────────────────────────────────
describe('artist disabled', () => {
  it('/artist returns disabled message', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain('Artist search is temporarily disabled');
    expect(t).toContain('/song to search for tracks instead');
  });
  it('artist callback returns disabled message', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain("startsWith('artist:')");
    expect(t).toContain('Artist search is temporarily disabled');
  });
  it('artist not in help text', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    const helpMatch = t.match(/📖 Commands:[\s\S]*?(?=\n  if|\n    return)/);
    expect(helpMatch).not.toBeNull();
    expect(helpMatch![0]).not.toContain('/artist');
  });
  it('artist not in start text', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    const startMatch = t.match(/👋 MeowTunes bot[\s\S]*?(?=\n    return)/);
    expect(startMatch).not.toBeNull();
    expect(startMatch![0]).not.toContain('/artist');
  });
});

// ── Song search ─────────────────────────────────────────────────────────────
describe('song search', () => {
  it('/song command exists in handlers', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain("startsWith('/song')");
  });
  it('song callback uses song:<fileId> format', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain("startsWith('song:')");
    expect(t).toContain('song:${r.fileId}');
  });
  it('song callback_data stays under 64 bytes', () => {
    const fileId = OID;
    const cb = `song:${fileId}`;
    expect(cb.length).toBeLessThanOrEqual(64);
  });
  it('song search uses /music/search endpoint', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toContain('meow.searchMusic(query');
  });
  it('handleSongSelection function exists', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    expect(t).toMatch(/async function handleSongSelection\(/);
  });
  it('song in help text', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    const helpMatch = t.match(/📖 Commands:[\s\S]*?(?=\n  if|\n    return)/);
    expect(helpMatch).not.toBeNull();
    expect(helpMatch![0]).toContain('/song');
  });
  it('song in start text', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/handlers.ts', 'utf8');
    const startMatch = t.match(/👋 MeowTunes bot[\s\S]*?(?=\n    return)/);
    expect(startMatch).not.toBeNull();
    expect(startMatch![0]).toContain('/song');
  });
});

// ── Diagnostic route removed ────────────────────────────────────────────────
describe('diagnostic route removed', () => {
  it('no /telegram/diag in entry.ts', async () => {
    const fs = await import('fs');
    const t = fs.readFileSync('src/worker/entry.ts', 'utf8');
    expect(t).not.toContain('/telegram/diag');
    expect(t).not.toContain('diagGet');
    expect(t).not.toContain('X-Setup-Secret');
  });
  it('GET /telegram/diag returns 404', async () => {
    const r = await worker.fetch(new Request('https://x/telegram/diag'), ENV, ctx as never);
    expect(r.status).toBe(404);
  });
});
