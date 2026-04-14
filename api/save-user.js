import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
  // GET: diagnostic (no secrets leaked) — lets you curl this and see
  // which piece is missing without opening Vercel logs.
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      env: {
        SUPABASE_URL: !!SUPABASE_URL,
        SUPABASE_SERVICE_KEY: !!SUPABASE_SERVICE_KEY,
        TELEGRAM_BOT_TOKEN: !!BOT_TOKEN,
      },
      supabase_client: !!supabase,
      bot_token_length: BOT_TOKEN ? BOT_TOKEN.length : 0,
      build: 'save-user v2',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    console.error('[save-user] supabase client missing (env vars not set)');
    return res.status(500).json({ error: 'server_not_configured', env: { url: !!SUPABASE_URL, key: !!SUPABASE_SERVICE_KEY } });
  }
  if (!BOT_TOKEN) {
    console.error('[save-user] TELEGRAM_BOT_TOKEN missing');
    return res.status(500).json({ error: 'bot_token_missing' });
  }

  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  console.log('[save-user] initData length:', initData ? initData.length : 0);
  if (!initData) return res.status(401).json({ error: 'no_init_data' });

  const verdict = hmacCheck(initData, BOT_TOKEN);
  if (!verdict.ok) {
    console.warn('[save-user] verify failed:', verdict.reason);
    return res.status(401).json({ error: 'verify_failed', reason: verdict.reason });
  }

  const user = verdict.user;
  if (!user?.id) {
    console.warn('[save-user] user payload missing id');
    return res.status(401).json({ error: 'no_user_id' });
  }
  console.log('[save-user] verified user', user.id, user.username || user.first_name);

  const body = readBody(req);
  const referredBy = Number.isFinite(body.referredBy) ? Math.floor(body.referredBy) : null;

  const row = {
    telegram_id: user.id,
    username: (user.username || user.first_name || '').slice(0, 50),
  };
  if (user.first_name) row.first_name = String(user.first_name).slice(0, 64);
  if (user.last_name) row.last_name = String(user.last_name).slice(0, 64);
  if (user.language_code) row.language_code = String(user.language_code).slice(0, 8);
  if (referredBy && referredBy !== user.id) row.referred_by = referredBy;

  let { data, error } = await supabase
    .from('users')
    .upsert(row, { onConflict: 'telegram_id', ignoreDuplicates: false })
    .select('telegram_id, username, created_at')
    .single();

  if (error && /column|does not exist|schema/i.test(error.message)) {
    console.warn('[save-user] schema mismatch, retrying minimal row:', error.message);
    const minimal = { telegram_id: row.telegram_id, username: row.username };
    if (row.referred_by) minimal.referred_by = row.referred_by;
    ({ data, error } = await supabase
      .from('users')
      .upsert(minimal, { onConflict: 'telegram_id', ignoreDuplicates: false })
      .select('telegram_id, username, created_at')
      .single());
  }

  if (error) {
    console.error('[save-user] supabase error:', error);
    return res.status(500).json({ error: 'db_error', message: error.message, code: error.code });
  }
  console.log('[save-user] upserted', data?.telegram_id);
  return res.status(200).json({ ok: true, user: data });
}
