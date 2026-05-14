import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

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
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  const user = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!user || !user.id) {
    // Don't 500 on auth failure — let the client treat it as "no remote data"
    return res.status(200).json({ user: null, degraded: 'no_auth' });
  }

  if (!supabase) {
    return res.status(200).json({ user: null, degraded: 'supabase_unconfigured' });
  }

  const telegramId = user.id;
  const username = (user.username || user.first_name || '').slice(0, 50);

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('users')
        .select('telegram_id, username, coins, high_score, referred_by, created_at')
        .eq('telegram_id', telegramId)
        .maybeSingle();
      if (error) {
        console.warn('[user] supabase select error (soft):', error.message);
        return res.status(200).json({ user: null, degraded: 'db_error' });
      }
      if (!data) {
        const { data: inserted, error: insErr } = await supabase
          .from('users')
          .insert({ telegram_id: telegramId, username })
          .select()
          .single();
        if (insErr) {
          console.warn('[user] supabase insert error (soft):', insErr.message);
          return res.status(200).json({ user: null, degraded: 'db_error' });
        }
        return res.status(200).json({ user: inserted, created: true });
      }
      return res.status(200).json({ user: data, created: false });
    }

    // POST — sync client progress; server keeps the maximum value seen
    const body = readBody(req);
    const clientCoins = Number.isFinite(body.coins) ? Math.max(0, Math.floor(body.coins)) : null;
    const clientHigh = Number.isFinite(body.highScore) ? Math.max(0, Math.floor(body.highScore)) : null;
    const referredBy = Number.isFinite(body.referredBy) ? Math.floor(body.referredBy) : null;

    const { data: current } = await supabase
      .from('users')
      .select('coins, high_score, referred_by')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    const patch = { telegram_id: telegramId, username };
    if (clientCoins !== null) {
      patch.coins = Math.min(clientCoins, 10_000_000);
    }
    if (clientHigh !== null) {
      patch.high_score = current ? Math.max(current.high_score ?? 0, clientHigh) : clientHigh;
    }
    if (referredBy && referredBy !== telegramId && (!current || !current.referred_by)) {
      patch.referred_by = referredBy;
    }

    const { data, error } = await supabase
      .from('users')
      .upsert(patch, { onConflict: 'telegram_id' })
      .select()
      .single();
    if (error) {
      console.warn('[user] supabase upsert error (soft):', error.message);
      return res.status(200).json({ user: null, degraded: 'db_error' });
    }
    return res.status(200).json({ user: data });
  } catch (e) {
    // DNS / network failures when Supabase host doesn't resolve etc
    console.warn('[user] supabase unreachable (soft):', e.message);
    return res.status(200).json({ user: null, degraded: 'supabase_unreachable' });
  }
}
