import crypto from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || '';

function hmacCheck(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return { ok: false };
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return { ok: false };
  const userRaw = params.get('user');
  if (!userRaw) return { ok: false };
  try { return { ok: true, user: JSON.parse(userRaw) }; } catch { return { ok: false }; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');

function who(user) {
  return user.username
    ? `@${esc(user.username)}`
    : `<code>${esc(user.id)}</code>`;
}

function buildMessage(type, body, user) {
  const w = who(user);

  if (type === 'level_done') {
    const ch = body.chapter || '?';
    const name = esc(body.levelName || `Lvl ${body.level}`);
    const score = body.score ? ` · ${fmt(body.score)}pts` : '';
    const earned = body.coinsEarned ? ` · +${fmt(body.coinsEarned)}🪙` : '';
    const total = body.coinsTotal != null ? ` · итого ${fmt(body.coinsTotal)}🪙` : '';
    return `🎮 Ch${ch} · ${name}${score}${earned}${total} · ${w}`;
  }

  if (type === 'chapter_unlocked') {
    const names = { 2: 'Night Shift', 3: 'Static' };
    const name = names[body.chapter] || `Ch${body.chapter}`;
    return `🔓 Chapter ${body.chapter} · ${name} · ${w}`;
  }

  if (type === 'record') {
    const ch = body.chapter || '?';
    const name = body.levelName ? ` · ${esc(body.levelName)}` : '';
    const prev = body.prev ? ` (было ${fmt(body.prev)})` : '';
    return `🏆 Рекорд Ch${ch}${name} · ${fmt(body.score)}${prev} · ${w}`;
  }

  return null;
}

async function tgSend(text) {
  if (!REPORT_CHAT_ID || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: REPORT_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: true,
      }),
    });
  } catch (e) {
    console.warn('[event] tg send failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!BOT_TOKEN) return res.status(200).json({ ok: true, degraded: 'no_token' });

  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  if (!initData) return res.status(200).json({ ok: true, degraded: 'no_init_data' });

  const verdict = hmacCheck(initData, BOT_TOKEN);
  if (!verdict.ok) return res.status(200).json({ ok: true, degraded: 'verify_failed' });

  const user = verdict.user;
  if (!user?.id) return res.status(200).json({ ok: true, degraded: 'no_user' });

  const body = readBody(req);
  if (!body.type) return res.status(200).json({ ok: true, degraded: 'no_type' });

  const text = buildMessage(body.type, body, user);
  if (text) await tgSend(text);

  return res.status(200).json({ ok: true, sent: !!text });
}
