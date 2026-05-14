import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || '';

// Fire-and-forget notify the admin channel that a user opened the app.
// Called once per session (client already gates with sessionStorage).
async function notifyChannel(user, referredBy, supabaseStatus) {
  if (!REPORT_CHAT_ID || !BOT_TOKEN) return;
  const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const lines = [
    '🆕 <b>New session</b>',
    `<code>${esc(user.id)}</code>` +
      (user.username ? ` · @${esc(user.username)}` : '') +
      (user.first_name ? ` · ${esc(user.first_name)}` + (user.last_name ? ' ' + esc(user.last_name) : '') : '') +
      (user.language_code ? ` · ${esc(user.language_code)}` : ''),
  ];
  if (referredBy) lines.push(`↳ ref: <code>${esc(referredBy)}</code>`);
  if (supabaseStatus !== 'ok') lines.push(`<i>db: ${esc(supabaseStatus)}</i>`);
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

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

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
    return res.status(200).json({
      ok: true,
      env: {
        SUPABASE_URL: !!SUPABASE_URL,
        SUPABASE_SERVICE_KEY: !!SUPABASE_SERVICE_KEY,
        TELEGRAM_BOT_TOKEN: !!BOT_TOKEN,
        REPORT_CHAT_ID: !!REPORT_CHAT_ID,
      },
      supabase_client: !!supabase,
      channel_notify: !!REPORT_CHAT_ID,
      build: 'save-user v4 (channel notify)',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate user even when storage is degraded — useful telemetry
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

  // If Supabase isn't configured (or unreachable), don't 500 — the
  // game's core flow doesn't need it. Still notify the admin channel
  // so user IDs are captured regardless of DB status.
  if (!supabase) {
    console.log('[save-user] supabase unavailable — skipping persistence for', user.id);
    await notifyChannel(user, referredBy, 'unconfigured');
    return res.status(200).json({ ok: true, degraded: 'supabase_unconfigured', user: { telegram_id: user.id } });
  }

  const row = {
    telegram_id: user.id,
    username: (user.username || user.first_name || '').slice(0, 50),
  };
  if (user.first_name) row.first_name = String(user.first_name).slice(0, 64);
  if (user.last_name) row.last_name = String(user.last_name).slice(0, 64);
  if (user.language_code) row.language_code = String(user.language_code).slice(0, 8);
  if (referredBy && referredBy !== user.id) row.referred_by = referredBy;

  try {
    let { data, error } = await supabase
      .from('users')
      .upsert(row, { onConflict: 'telegram_id', ignoreDuplicates: false })
      .select('telegram_id, username, created_at')
      .single();

    if (error && /column|does not exist|schema/i.test(error.message)) {
      const minimal = { telegram_id: row.telegram_id, username: row.username };
      if (row.referred_by) minimal.referred_by = row.referred_by;
      ({ data, error } = await supabase
        .from('users')
        .upsert(minimal, { onConflict: 'telegram_id', ignoreDuplicates: false })
        .select('telegram_id, username, created_at')
        .single());
    }

    if (error) {
      console.warn('[save-user] supabase error (soft):', error.message);
      await notifyChannel(user, referredBy, 'db_error');
      return res.status(200).json({ ok: true, degraded: 'db_error', message: error.message, user: { telegram_id: user.id } });
    }
    await notifyChannel(user, referredBy, 'ok');
    return res.status(200).json({ ok: true, user: data });
  } catch (e) {
    // Network/DNS errors when Supabase is gone — soft-fail
    console.warn('[save-user] supabase unreachable (soft):', e.message);
    await notifyChannel(user, referredBy, 'unreachable');
    return res.status(200).json({ ok: true, degraded: 'supabase_unreachable', user: { telegram_id: user.id } });
  }
}
