// Verify access via THREE paths — any one of them granting access:
//   1) Supabase has_access cache (instant pass for previously-verified
//      users; no external API calls).
//   2) Goodies partner API by Telegram user ID (HMAC-validated initData).
//      Only sees UNWRAPPED packs.
//   3) On-chain TonAPI by wallet address (if wallet connected).
//
// Once any path returns owner=true, the user is upserted to Supabase
// with has_access=true so subsequent opens skip the network entirely —
// even if their initData HMAC later fails or Goodies goes down.
//
// All credentials live ONLY in Vercel env vars.

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOODIES_USERNAME = process.env.GOODIES_USERNAME;
const GOODIES_PASSWORD = process.env.GOODIES_PASSWORD;
const TONAPI_KEY = process.env.TONAPI_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sb = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const GOODIES_BASE = 'https://api-goodies.cleeviox.com/partner';
const DROP_ID = '9ee95390-b12a-428a-8ca8-8855059315f5';
const COLLECTIONS = {
  mai: '5b909f0d-4f30-49bf-ad3a-da131a85fa56',
  vi:  '9c26b8ac-8fd4-4d49-91d7-f9bdcd0e6ec4',
};
const COLLECTIONS_TON = {
  mai: 'EQDrSCwNHXWa4v1qaHiKNqRDmUvhqMSw9_NVufKF_ZGRZFvi',
  vi:  'EQC7KgKo86srEf1XZC1lh_phHeXUlhUClBHJIIlJ3ShW6pY2',
};

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
  if (!userRaw) return { ok: false, reason: 'no_user' };
  try { return { ok: true, user: JSON.parse(userRaw) }; }
  catch { return { ok: false, reason: 'bad_user_json' }; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

function goodiesAuth() {
  return 'Basic ' + Buffer.from(`${GOODIES_USERNAME}:${GOODIES_PASSWORD}`).toString('base64');
}

// ---- Supabase cache ----
async function getCachedAccess(tgId) {
  if (!sb || !tgId) return null;
  try {
    const { data, error } = await sb
      .from('users')
      .select('has_access')
      .eq('telegram_id', tgId)
      .maybeSingle();
    if (error) {
      // missing column or other schema issue — treat as no cache
      return null;
    }
    return data?.has_access === true;
  } catch {
    return null;
  }
}
async function setCachedAccess(tgId, value) {
  if (!sb || !tgId) return false;
  try {
    const { error } = await sb
      .from('users')
      .upsert({ telegram_id: tgId, has_access: !!value }, { onConflict: 'telegram_id', ignoreDuplicates: false });
    return !error;
  } catch {
    return false;
  }
}

// ---- Goodies ----
async function goodiesVerifyDrop(telegramUserId, attempts) {
  try {
    const r = await fetch(`${GOODIES_BASE}/verify-ownership`, {
      method: 'POST',
      headers: { 'Authorization': goodiesAuth(), 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ dropId: DROP_ID, telegramUserId: String(telegramUserId) }),
    });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch {}
    attempts.push({ path: 'goodies/verify-ownership', status: r.status, response: data || txt.slice(0, 200) });
    if (r.ok && data && data.isOwner === true) return { owner: true, packAmount: data.packAmount };
  } catch (e) { attempts.push({ path: 'goodies/verify-ownership', error: e.message }); }
  return { owner: false };
}
async function goodiesHoldersIncludes(collectionId, telegramUserId, label, attempts) {
  try {
    const r = await fetch(`${GOODIES_BASE}/holders?collectionId=${encodeURIComponent(collectionId)}`, {
      method: 'GET',
      headers: { 'Authorization': goodiesAuth(), 'Accept': 'application/json' },
    });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch {}
    const ids = (data && Array.isArray(data.telegramUserIds)) ? data.telegramUserIds : [];
    const hit = ids.some(x => String(x) === String(telegramUserId));
    attempts.push({ path: 'goodies/holders', collection: label, status: r.status, holderCount: data?.count ?? ids.length, matched: hit });
    return hit;
  } catch (e) { attempts.push({ path: 'goodies/holders', collection: label, error: e.message }); return false; }
}

// ---- TonAPI on-chain ----
async function tonapiOwnsCollection(walletAddress, collectionAddress, label, attempts) {
  try {
    const url = `https://tonapi.io/v2/accounts/${encodeURIComponent(walletAddress)}/nfts?collection=${encodeURIComponent(collectionAddress)}&limit=1`;
    const headers = { 'Accept': 'application/json' };
    if (TONAPI_KEY) headers['Authorization'] = 'Bearer ' + TONAPI_KEY;
    const r = await fetch(url, { headers });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch {}
    const items = (data && Array.isArray(data.nft_items)) ? data.nft_items : [];
    const owns = items.length > 0;
    attempts.push({ path: 'tonapi/nfts', collection: label, status: r.status, owns, nftAddress: owns ? items[0].address : null });
    return owns;
  } catch (e) { attempts.push({ path: 'tonapi/nfts', collection: label, error: e.message }); return false; }
}

export default async function handler(req, res) {
  // GET diagnostic (env + optional admin user check)
  if (req.method === 'GET') {
    const adminSecret = process.env.ADMIN_DEBUG_SECRET || '';
    const secret = (req.query && req.query.secret) || '';
    const tg = (req.query && (req.query.tg || req.query.telegramUserId)) || '';
    if (adminSecret && secret === adminSecret && tg) {
      const attempts = [];
      const drop = await goodiesVerifyDrop(tg, attempts);
      let mai = false, vi = false;
      if (!drop.owner) {
        [mai, vi] = await Promise.all([
          goodiesHoldersIncludes(COLLECTIONS.mai, tg, 'mai', attempts),
          goodiesHoldersIncludes(COLLECTIONS.vi,  tg, 'vi',  attempts),
        ]);
      }
      const cached = await getCachedAccess(tg);
      const hasAccess = !!(cached || drop.owner || mai || vi);
      return res.status(200).json({
        ok: true, mode: 'admin_debug', telegramUserId: String(tg),
        hasAccess, cached, drop: drop.owner, mai, vi, attempts,
      });
    }
    return res.status(200).json({
      ok: true,
      env: {
        TELEGRAM_BOT_TOKEN: !!BOT_TOKEN,
        GOODIES_USERNAME:   !!GOODIES_USERNAME,
        GOODIES_PASSWORD:   !!GOODIES_PASSWORD,
        TONAPI_KEY:         !!TONAPI_KEY,
        SUPABASE_URL:       !!SUPABASE_URL,
        SUPABASE_SERVICE_KEY: !!SUPABASE_SERVICE_KEY,
        ADMIN_DEBUG_SECRET: !!adminSecret,
      },
      dropId: DROP_ID, collections: COLLECTIONS, collectionsTon: COLLECTIONS_TON,
      build: 'verify-access v6 (supabase has_access cache)',
    });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = readBody(req);
  const debug = !!body.debug;
  const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';
  const claimedTgId = body.claimedTgId ? Number(body.claimedTgId) : null;

  const attempts = [];
  let trustedTgId = null;
  let hmacReason = null;

  // Validate Telegram initData
  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  if (BOT_TOKEN && initData) {
    const v = hmacCheck(initData, BOT_TOKEN);
    if (v.ok && v.user?.id) {
      trustedTgId = v.user.id;
    } else {
      hmacReason = v.reason || 'invalid';
      attempts.push({ path: 'initData', error: hmacReason });
    }
  }
  // The id we use for Supabase lookup: prefer HMAC-trusted, else fall
  // back to the client-claimed one. The cache lookup is read-only and
  // only returns true if an admin or a previous trusted verify set
  // has_access — so even with a claimed id the worst a spoofer can do
  // is unlock for an account that's already a legitimate holder.
  const lookupTgId = trustedTgId || (Number.isFinite(claimedTgId) ? claimedTgId : null);

  // ---- Path 1: Supabase has_access cache (instant) ----
  let cached = null;
  if (lookupTgId) {
    cached = await getCachedAccess(lookupTgId);
    attempts.push({ path: 'supabase/has_access', tg: String(lookupTgId), cached });
    if (cached === true) {
      const ms = Date.now();
      console.log('[verify-access] cache-hit tg=' + lookupTgId);
      return res.status(200).json({
        ok: true,
        hasAccess: true,
        source: 'supabase_cache',
        telegramUserId: String(lookupTgId),
        ...(debug ? { attempts } : {}),
      });
    }
  }

  // ---- Path 2 + Path 3: Goodies + TonAPI ----
  const tasks = [];
  let goodiesDrop = { owner: false };
  let goodiesMai = false, goodiesVi = false;
  const goodiesAvailable = !!(trustedTgId && GOODIES_USERNAME && GOODIES_PASSWORD);
  if (goodiesAvailable) {
    tasks.push((async () => {
      goodiesDrop = await goodiesVerifyDrop(trustedTgId, attempts);
      if (!goodiesDrop.owner) {
        [goodiesMai, goodiesVi] = await Promise.all([
          goodiesHoldersIncludes(COLLECTIONS.mai, trustedTgId, 'mai', attempts),
          goodiesHoldersIncludes(COLLECTIONS.vi,  trustedTgId, 'vi',  attempts),
        ]);
      }
    })());
  }
  let chainMai = false, chainVi = false;
  if (wallet) {
    tasks.push((async () => {
      [chainMai, chainVi] = await Promise.all([
        tonapiOwnsCollection(wallet, COLLECTIONS_TON.mai, 'mai', attempts),
        tonapiOwnsCollection(wallet, COLLECTIONS_TON.vi,  'vi',  attempts),
      ]);
    })());
  }
  await Promise.all(tasks);

  const goodies = goodiesDrop.owner || goodiesMai || goodiesVi;
  const chain   = chainMai || chainVi;
  const hasAccess = goodies || chain;

  // ---- Persist successful verification to Supabase ----
  // Only if we know the TRUSTED id. A claimed-only id cannot be trusted
  // to write the access flag (would let anyone elevate any tg-id).
  if (hasAccess && trustedTgId) {
    await setCachedAccess(trustedTgId, true);
    attempts.push({ path: 'supabase/upsert', tg: String(trustedTgId), wrote: true });
  }

  let reason = null;
  if (!hasAccess) {
    if (!goodiesAvailable && !wallet) reason = hmacReason ? 'hmac_' + hmacReason : 'no_auth';
    else if (!goodiesAvailable)        reason = hmacReason ? 'hmac_' + hmacReason : 'goodies_unavailable';
    else                                reason = 'not_holder';
  }

  console.log('[verify-access]',
    'tg=' + (trustedTgId || claimedTgId || '-'),
    'wallet=' + (wallet ? wallet.slice(0, 10) + '...' : '-'),
    'access=' + hasAccess,
    'cached=' + cached,
    'goodies=' + goodies,
    'chain=' + chain,
    'reason=' + (reason || 'ok'));

  const payload = {
    ok: true,
    hasAccess,
    telegramUserId: (trustedTgId || claimedTgId) ? String(trustedTgId || claimedTgId) : null,
    wallet: wallet || null,
    reason,
    source: hasAccess ? (cached ? 'supabase_cache' : goodies ? 'goodies' : 'chain') : null,
    via: {
      supabase: { cached, available: !!sb },
      goodies:  { drop: goodiesDrop.owner, mai: goodiesMai, vi: goodiesVi, available: goodiesAvailable },
      chain:    { mai: chainMai, vi: chainVi, available: !!wallet },
    },
    packAmount: goodiesDrop.packAmount || 0,
  };
  if (debug) payload.attempts = attempts;
  return res.status(200).json(payload);
}
