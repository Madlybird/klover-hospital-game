// Admin-only stats endpoint.
//
// GET /api/stats?secret=<ADMIN_DEBUG_SECRET>
//   returns user counts broken down by time window.
//
// GET /api/stats?secret=...&since=<ISO|seconds|hours_ago>
//   returns count of users created since the given moment.
//
// GET /api/stats?secret=...&user=<tg_id>
//   returns single-user row.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_DEBUG_SECRET;

const sb = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function parseSince(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // hours-ago shorthand: "24h", "3d"
  const m = s.match(/^(\d+)\s*([hd])$/i);
  if (m) {
    const n = Number(m[1]);
    const ms = n * (m[2].toLowerCase() === 'h' ? 3600 : 86400) * 1000;
    return new Date(Date.now() - ms).toISOString();
  }
  // ISO or plain date
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

async function countSince(iso) {
  const { count, error } = await sb
    .from('users')
    .select('telegram_id', { count: 'exact', head: true })
    .gte('created_at', iso);
  if (error) return { error: error.message };
  return { count: count || 0, since: iso };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!ADMIN_SECRET || (req.query?.secret || '') !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!sb) {
    return res.status(500).json({ error: 'supabase_not_configured' });
  }

  const userParam = req.query?.user;
  if (userParam) {
    const { data, error } = await sb
      .from('users')
      .select('*')
      .eq('telegram_id', Number(userParam))
      .maybeSingle();
    return res.status(200).json({ ok: true, user: data || null, error: error?.message || null });
  }

  const sinceParam = req.query?.since;
  if (sinceParam) {
    const iso = parseSince(sinceParam);
    if (!iso) return res.status(400).json({ error: 'bad_since', hint: 'use ISO date, 24h, 7d, etc.' });
    return res.status(200).json({ ok: true, ...(await countSince(iso)) });
  }

  // Default: counts across common windows
  const now = Date.now();
  const windows = {
    last_1h:  new Date(now - 3600e3).toISOString(),
    last_24h: new Date(now - 86400e3).toISOString(),
    last_7d:  new Date(now - 7 * 86400e3).toISOString(),
    last_30d: new Date(now - 30 * 86400e3).toISOString(),
  };
  const totals = {};
  for (const [k, iso] of Object.entries(windows)) {
    totals[k] = (await countSince(iso)).count;
  }
  const { count: total } = await sb
    .from('users')
    .select('telegram_id', { count: 'exact', head: true });
  const { data: latest } = await sb
    .from('users')
    .select('telegram_id, username, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  return res.status(200).json({
    ok: true,
    total: total || 0,
    windows: totals,
    latest,
    serverTime: new Date().toISOString(),
  });
}
