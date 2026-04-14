import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Env vars supplied by Vercel at runtime. Never commit real values.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// Telegram initData HMAC check. Returns the parsed user object or null.
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try { return JSON.parse(userRaw); } catch { return null; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(500).json({ error: 'Server not configured' });

  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  const user = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!user || !user.id) return res.status(401).json({ error: 'Invalid Telegram data' });

  const body = readBody(req);
  const referredBy = Number.isFinite(body.referredBy) ? Math.floor(body.referredBy) : null;

  const row = {
    telegram_id: user.id,
    username: (user.username || user.first_name || '').slice(0, 50),
  };
  // Optional columns — harmless if they don't exist in the table schema,
  // Supabase will 400; fall back to minimal row on failure below.
  if (user.first_name) row.first_name = String(user.first_name).slice(0, 64);
  if (user.last_name) row.last_name = String(user.last_name).slice(0, 64);
  if (user.language_code) row.language_code = String(user.language_code).slice(0, 8);
  if (referredBy && referredBy !== user.id) row.referred_by = referredBy;

  let { data, error } = await supabase
    .from('users')
    .upsert(row, { onConflict: 'telegram_id', ignoreDuplicates: false })
    .select('telegram_id, username, created_at')
    .single();

  // Retry with minimal columns if optional fields aren't in the schema yet.
  if (error && /column|does not exist|schema/i.test(error.message)) {
    const minimal = { telegram_id: row.telegram_id, username: row.username };
    if (row.referred_by) minimal.referred_by = row.referred_by;
    ({ data, error } = await supabase
      .from('users')
      .upsert(minimal, { onConflict: 'telegram_id', ignoreDuplicates: false })
      .select('telegram_id, username, created_at')
      .single());
  }

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, user: data });
}
