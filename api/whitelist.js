// Admin endpoint: grant/revoke users.has_access by Telegram ID.
//
// POST /api/whitelist?secret=<ADMIN_DEBUG_SECRET>
//   body: { tg_ids: [<int>...], grant?: true }
//   sets has_access for those rows (creates them if missing).
//
// GET  /api/whitelist?secret=<ADMIN_DEBUG_SECRET>
//   returns the current whitelist (all has_access=true rows).
//
// GET  /api/whitelist?secret=...&sync=1
//   pulls every Telegram user ID from Goodies (drop + MAI + VI
//   holder lists) and upserts them all with has_access=true.
//   Run this once after deploying to pre-warm the cache.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_DEBUG_SECRET;
const GOODIES_USERNAME = process.env.GOODIES_USERNAME;
const GOODIES_PASSWORD = process.env.GOODIES_PASSWORD;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function botSendMessage(chatId, text) {
  if (!BOT_TOKEN) return { ok: false, error: 'bot_token_missing' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: !!data.ok, status: r.status, response: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const sb = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const GOODIES_BASE = 'https://api-goodies.cleeviox.com/partner';
const DROP_ID = '9ee95390-b12a-428a-8ca8-8855059315f5';
const COLLECTIONS = {
  mai: '5b909f0d-4f30-49bf-ad3a-da131a85fa56',
  vi:  '9c26b8ac-8fd4-4d49-91d7-f9bdcd0e6ec4',
};

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}
function goodiesAuth() {
  return 'Basic ' + Buffer.from(`${GOODIES_USERNAME}:${GOODIES_PASSWORD}`).toString('base64');
}

async function fetchHoldersList(endpoint) {
  try {
    const r = await fetch(endpoint, { headers: { 'Authorization': goodiesAuth(), 'Accept': 'application/json' } });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.telegramUserIds) ? data.telegramUserIds : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (!ADMIN_SECRET || (req.query?.secret || '') !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // sb may be null (Supabase env removed) — POST/notify still work,
  // GET list/sync need Supabase. Each branch handles its own check.

  if (req.method === 'GET') {
    if (!sb) return res.status(200).json({ ok: false, error: 'supabase_unconfigured' });
    // Sync mode — pull all Goodies holders and upsert has_access=true
    if (req.query?.sync === '1' || req.query?.sync === 'true') {
      if (!GOODIES_USERNAME || !GOODIES_PASSWORD) {
        return res.status(500).json({ error: 'goodies_creds_missing' });
      }
      const [dropIds, maiIds, viIds] = await Promise.all([
        fetchHoldersList(`${GOODIES_BASE}/drop-holders?dropId=${encodeURIComponent(DROP_ID)}`),
        fetchHoldersList(`${GOODIES_BASE}/holders?collectionId=${encodeURIComponent(COLLECTIONS.mai)}`),
        fetchHoldersList(`${GOODIES_BASE}/holders?collectionId=${encodeURIComponent(COLLECTIONS.vi)}`),
      ]);
      const all = new Set([...dropIds, ...maiIds, ...viIds].map(x => Number(x)).filter(Number.isFinite));
      const rows = [...all].map(telegram_id => ({ telegram_id, has_access: true }));
      let upserted = 0, error = null;
      // chunk to be safe
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const { error: e } = await sb
          .from('users')
          .upsert(slice, { onConflict: 'telegram_id', ignoreDuplicates: false });
        if (e) { error = e.message; break; }
        upserted += slice.length;
      }
      return res.status(200).json({
        ok: !error, error,
        totals: { drop: dropIds.length, mai: maiIds.length, vi: viIds.length, unique: all.size },
        upserted,
      });
    }

    // List mode — return current whitelist
    const { data, error } = await sb
      .from('users')
      .select('telegram_id, username, created_at')
      .eq('has_access', true)
      .order('telegram_id', { ascending: true });
    return res.status(200).json({ ok: !error, error: error?.message || null, count: data?.length || 0, users: data || [] });
  }

  if (req.method === 'POST') {
    const body = readBody(req);
    const grant = body.grant !== false; // default true
    const notify = body.notify !== false; // default true
    const message = typeof body.message === 'string' && body.message.length
      ? body.message
      : '✅ Access granted to Klover Hospital. Open the mini-app and tap any button — you\'re in.';
    const tgIds = Array.isArray(body.tg_ids) ? body.tg_ids.map(Number).filter(Number.isFinite) : [];
    if (!tgIds.length) return res.status(400).json({ error: 'no_tg_ids' });

    // Persist in Supabase (soft-fail if unreachable)
    let dbError = null;
    if (sb) {
      try {
        const rows = tgIds.map(telegram_id => ({ telegram_id, has_access: grant }));
        const { error } = await sb
          .from('users')
          .upsert(rows, { onConflict: 'telegram_id', ignoreDuplicates: false });
        if (error) dbError = error.message;
      } catch (e) { dbError = e.message; }
    } else {
      dbError = 'supabase_unconfigured';
    }

    // Notify each user via Telegram bot
    const notifications = [];
    if (notify && grant) {
      for (const tgId of tgIds) {
        const r = await botSendMessage(tgId, message);
        notifications.push({ tg: tgId, ok: r.ok, error: r.error || (r.response && r.response.description) || null });
      }
    }

    return res.status(200).json({
      ok: true,
      modified: tgIds.length,
      grant,
      dbError,
      notifications,
    });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}
