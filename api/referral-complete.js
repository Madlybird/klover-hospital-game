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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Always return 200 — the referral reward is a nice-to-have, not a
  // blocker. If Supabase is unreachable we just skip silently and let
  // the client move on with the game flow.
  if (!supabase || !BOT_TOKEN) {
    return res.status(200).json({ ok: true, credited: false, degraded: 'server_not_configured' });
  }
  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  const verdict = hmacCheck(initData, BOT_TOKEN);
  if (!verdict.ok || !verdict.user?.id) {
    return res.status(200).json({ ok: true, credited: false, degraded: 'verify_failed' });
  }
  const telegramId = verdict.user.id;

  try {
    const { data: me, error: loadErr } = await supabase
      .from('users')
      .select('telegram_id, referred_by, level1_complete')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (loadErr) {
      console.warn('[referral-complete] load err (soft):', loadErr.message);
      return res.status(200).json({ ok: true, credited: false, degraded: 'db_error' });
    }
    if (!me) {
      return res.status(200).json({ ok: true, credited: false, reason: 'user_not_found' });
    }
    if (me.level1_complete) {
      return res.status(200).json({ ok: true, credited: false, reason: 'already_flagged' });
    }

    const { error: flagErr } = await supabase
      .from('users')
      .update({ level1_complete: true })
      .eq('telegram_id', telegramId);
    if (flagErr) {
      console.warn('[referral-complete] flag err (soft):', flagErr.message);
      return res.status(200).json({ ok: true, credited: false, degraded: 'db_error' });
    }

    if (!me.referred_by) {
      return res.status(200).json({ ok: true, credited: false, reason: 'no_referrer' });
    }

    const { data: ref, error: refLoadErr } = await supabase
      .from('users')
      .select('telegram_id, coins')
      .eq('telegram_id', me.referred_by)
      .maybeSingle();
    if (refLoadErr || !ref) {
      return res.status(200).json({ ok: true, credited: false, reason: 'referrer_missing' });
    }

    const newCoins = Math.min(10_000_000, (ref.coins ?? 0) + 500);
    const { error: updErr } = await supabase
      .from('users')
      .update({ coins: newCoins })
      .eq('telegram_id', ref.telegram_id);
    if (updErr) {
      console.warn('[referral-complete] update err (soft):', updErr.message);
      return res.status(200).json({ ok: true, credited: false, degraded: 'db_error' });
    }

    return res.status(200).json({ ok: true, credited: true, referrer: ref.telegram_id, amount: 500 });
  } catch (e) {
    console.warn('[referral-complete] supabase unreachable (soft):', e.message);
    return res.status(200).json({ ok: true, credited: false, degraded: 'supabase_unreachable' });
  }
}
