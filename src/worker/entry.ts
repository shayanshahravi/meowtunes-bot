import { createLogger, loadConfig, type Env, type WorkerContext } from './env';
import { TelegramApi } from './telegram';
import { WorkerMeowClient } from './meowtunes';
import { handleTelegramUpdate } from './handlers';

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Public routes
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return json({ ok: true, service: 'meowtunes-telegram-bot', mode: 'worker', time: new Date().toISOString() });
    }

    // Webhook
    if (path === '/telegram/webhook') {
      if (request.method !== 'POST') return text('Method Not Allowed', 405);
      let raw: string;
      try {
        raw = await request.text();
      } catch {
        return text('Bad Request — unreadable body', 400);
      }
      if (!raw || raw.length === 0) return text('Bad Request — empty body', 400);

      let envErr: string | null = null;
      let cfg: ReturnType<typeof loadConfig> | null = null;
      let log: ReturnType<typeof createLogger> | null = null;
      try {
        cfg = loadConfig(env);
        log = createLogger(env.LOG_LEVEL);
      } catch (err) {
        envErr = (err as Error).message;
      }
      if (!cfg || !log) {
        console.error(`[worker] config error: ${envErr}`);
        return text('Server misconfigured', 500);
      }

      // Secret-token check — header name is exactly what Telegram sends
      const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (!got || got !== cfg.webhookSecret) {
        log.warn('webhook rejected — bad secret', { path });
        return text('Forbidden', 403);
      }

      let update: Record<string, unknown>;
      try {
        update = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        log.warn('webhook rejected — malformed JSON', { path });
        return text('Bad Request — malformed JSON', 400);
      }
      // Minimal shape check
      if (typeof update !== 'object' || update === null) {
        log.warn('webhook rejected — invalid update shape', { path });
        return text('Bad Request', 400);
      }

      try {
        const tg = new TelegramApi(cfg.botToken, log);
        const meow = new WorkerMeowClient(cfg, log);
        // Long downloads must not block the webhook response: Telegram
        // retries slow webhooks. Acknowledge immediately and keep working
        // via waitUntil (killed after ~30s wall on free plan — see README).
        ctx.waitUntil(handleTelegramUpdate(update, { cfg, log, meow, tg }).catch((err) => log.error('update handler error', { error: (err as Error).message })));
        return json({ ok: true });
      } catch (err) {
        log.error('update handler error', { error: (err as Error).message });
        // Return 200 so Telegram does not retry malformed logic endlessly; the
        // user already got (or will get) a best-effort message from the handler.
        // Only auth/config errors above return non-2xx.
        return json({ ok: false, error: (err as Error).message.slice(0, 200) });
      }
    }

    return text('Not Found', 404);
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
