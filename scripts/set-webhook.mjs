#!/usr/bin/env node
/**
 * Register the Telegram webhook for the Cloudflare Worker.
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... WORKER_URL=https://<worker>.workers.dev TELEGRAM_WEBHOOK_SECRET=... node scripts/set-webhook.mjs
 * Env (or CLI args --token/--url/--secret). Never commit real values.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);
const token = process.env.TELEGRAM_BOT_TOKEN || args.token;
const base = (process.env.WORKER_URL || args.url || '').replace(/\/+$/, '');
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || args.secret;

if (!token || !base || !secret) {
  console.error('Usage: TELEGRAM_BOT_TOKEN=... WORKER_URL=https://<worker>.workers.dev TELEGRAM_WEBHOOK_SECRET=... node scripts/set-webhook.mjs');
  process.exit(1);
}
const url = `${base}/telegram/webhook`;
const api = `https://api.telegram.org/bot${token}/setWebhook`;
const resp = await fetch(api, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, secret_token: secret, drop_pending_updates: true }),
});
const text = await resp.text();
console.log(`POST ${api.replace(token, '[REDACTED]')} -> ${resp.status}`);
console.log(text.slice(0, 1000));
if (!resp.ok) process.exit(1);
