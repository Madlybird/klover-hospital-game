// One-off TEST broadcast. Hardcoded recipient list + fixed message so
// it can't be abused as an open broadcast tool. Sends a short teaser +
// a "play" Mini App button (no GIF). Safe to delete after use.

import crypto from 'node:crypto';

export const config = { maxDuration: 60 };

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const ADMIN_SECRET = process.env.ADMIN_DEBUG_SECRET || '';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const PUSH_TEXT = '🩷 Psst. Something new opened at the clinic.';

// Recipient list comes from env (comma-separated Telegram IDs). Never
// hardcode real user IDs in source — that leaks PII into the repo.
const RECIPIENTS = (process.env.PUSH_RECIPIENTS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Number.isFinite);

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `https://${host}` : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (!BOT_TOKEN) {
    return res.status(200).json({ ok: false, reason: 'bot_token_missing' });
  }
  // Admin-gated: this fires a real broadcast, so require the shared secret.
  // Without it, anyone hitting the URL could spam the recipient list.
  const provided = req.headers['x-admin-secret'] || req.query?.secret || '';
  if (!ADMIN_SECRET || !safeEqual(provided, ADMIN_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Dry-run probe: lets us confirm the new deploy is live WITHOUT
  // sending anything, so polling doesn't trigger the broadcast.
  const isDry = /(?:[?&])dry=1\b/.test(req.url || '') || req.query?.dry === '1';
  if (isDry) {
    return res.status(200).json({ ok: true, dry: true, ready: true, build: 'broadcast-v2' });
  }

  const host = baseUrl(req);
  const keyboard = {
    inline_keyboard: [[
      { text: '🏥 Open the clinic', web_app: { url: host + '/' } },
    ]],
  };

  const ids = [...new Set(RECIPIENTS)];
  if (!ids.length) {
    return res.status(200).json({ ok: true, total: 0, sent: 0, failed: 0, note: 'no recipients configured (set PUSH_RECIPIENTS)' });
  }
  const results = [];
  let sent = 0;
  let failed = 0;

  for (const id of ids) {
    const r = await tg('sendMessage', {
      chat_id: id,
      text: PUSH_TEXT,
      reply_markup: keyboard,
    });
    if (r && r.ok === true) {
      sent++;
      results.push({ id, ok: true });
    } else {
      failed++;
      results.push({ id, ok: false, error: r?.description || 'unknown' });
    }
    // Gentle throttle — stay well under Telegram's broadcast limits.
    await sleep(60);
  }

  return res.status(200).json({
    ok: true,
    total: ids.length,
    sent,
    failed,
    results,
  });
}
