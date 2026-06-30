import crypto from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || '';
const ADMIN_SECRET = process.env.ADMIN_DEBUG_SECRET || '';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

async function notifyChannel(user, referredBy, extra) {
  if (!REPORT_CHAT_ID || !BOT_TOKEN) return;
  const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  const platEmoji = { ios: '🍎', android: '🤖', android_x: '🤖', macos: '💻', tdesktop: '💻', weba: '💻', web: '💻', webk: '💻' };
  const plat = extra?.platform ? (platEmoji[extra.platform] || '📱') + ' ' + extra.platform : '';
  const premium = user.is_premium ? ' ⭐' : '';

  const lines = [
    (extra?.isNew ? '🆕 <b>New player</b>' : '🔁 <b>Session</b>') + (plat ? ' · ' + plat : '') + premium,
    `<code>${esc(user.id)}</code>` +
      (user.username ? ` · @${esc(user.username)}` : '') +
      (user.first_name ? ` · ${esc(user.first_name)}` + (user.last_name ? ' ' + esc(user.last_name) : '') : '') +
      (user.language_code ? ` · ${esc(user.language_code).toUpperCase()}` : ''),
  ];
  if (referredBy) lines.push(`↳ реф от <code>${esc(referredBy)}</code>`);

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: REPORT_CHAT_ID,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: true,
      }),
    });
  } catch (e) {
    console.warn('[save-user] notify channel failed:', e.message);
  }
}

function hmacCheck(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return { ok: false, reason: 'bad_hmac' };
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return { ok: false, reason: 'no_auth_date' };
  if (Date.now() / 1000 - authDate > 86400) return { ok: false, reason: 'stale' };
  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'no_user_param' };
  try { return { ok: true, user: JSON.parse(userRaw) }; }
  catch { return { ok: false, reason: 'bad_user_json' }; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const provided = req.headers['x-admin-secret'] || req.query?.secret || '';
    if (!ADMIN_SECRET || !safeEqual(provided, ADMIN_SECRET)) {
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({
      ok: true,
      env: { TELEGRAM_BOT_TOKEN: !!BOT_TOKEN, REPORT_CHAT_ID: !!REPORT_CHAT_ID },
      channel_notify: !!REPORT_CHAT_ID,
      build: 'save-user v6 (no-supabase)',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!BOT_TOKEN) {
    return res.status(200).json({ ok: true, degraded: 'bot_token_missing' });
  }

  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  if (!initData) return res.status(200).json({ ok: true, degraded: 'no_init_data' });

  const verdict = hmacCheck(initData, BOT_TOKEN);
  if (!verdict.ok) {
    return res.status(200).json({ ok: true, degraded: 'verify_failed', reason: verdict.reason });
  }
  const user = verdict.user;
  if (!user?.id) return res.status(200).json({ ok: true, degraded: 'no_user_id' });

  const body = readBody(req);
  const referredBy = Number.isFinite(body.referredBy) ? Math.floor(body.referredBy) : null;
  const platform = typeof body.platform === 'string' ? body.platform.slice(0, 32) : null;
  const isNew = body.isNew === true;

  await notifyChannel(user, referredBy, { platform, isNew });

  return res.status(200).json({ ok: true, user: { telegram_id: user.id } });
}
