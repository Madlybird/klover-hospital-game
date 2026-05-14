// Verify access by checking ownership of MAI Nurse / VI Rx NFTs.
//
// Two parallel paths — either one granting access:
//   1) Goodies partner API by Telegram user ID
//      (POST /partner/verify-ownership + /partner/holders).
//      Only sees UNWRAPPED packs.
//   2) Direct on-chain check via TonAPI by wallet address.
//      Canonical: catches wrapped/unwrapped, off-Goodies transfers,
//      secondary-market purchases, etc.
//
// Goodies credentials and the Telegram bot token live ONLY in Vercel
// env vars. They never reach the browser bundle.

import crypto from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOODIES_USERNAME = process.env.GOODIES_USERNAME;
const GOODIES_PASSWORD = process.env.GOODIES_PASSWORD;
const TONAPI_KEY = process.env.TONAPI_KEY || ''; // optional, raises rate limit

const GOODIES_BASE = 'https://api-goodies.cleeviox.com/partner';
const DROP_ID = '9ee95390-b12a-428a-8ca8-8855059315f5';
const COLLECTIONS = {
  mai: '5b909f0d-4f30-49bf-ad3a-da131a85fa56',
  vi:  '9c26b8ac-8fd4-4d49-91d7-f9bdcd0e6ec4',
};
// TON on-chain collection addresses
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
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

// ---------- Path 1: Goodies (telegram user id) ----------
function goodiesAuth() {
  return 'Basic ' + Buffer.from(`${GOODIES_USERNAME}:${GOODIES_PASSWORD}`).toString('base64');
}

async function goodiesVerifyDrop(telegramUserId, attempts) {
  try {
    const r = await fetch(`${GOODIES_BASE}/verify-ownership`, {
      method: 'POST',
      headers: {
        'Authorization': goodiesAuth(),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ dropId: DROP_ID, telegramUserId: String(telegramUserId) }),
    });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch {}
    attempts.push({ path: 'goodies/verify-ownership', status: r.status, response: data || txt.slice(0, 300) });
    if (r.ok && data && data.isOwner === true) {
      return { owner: true, packAmount: data.packAmount };
    }
  } catch (e) {
    attempts.push({ path: 'goodies/verify-ownership', error: e.message });
  }
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
    attempts.push({
      path: 'goodies/holders', collection: label,
      status: r.status, holderCount: data?.count ?? ids.length, matched: hit,
    });
    return hit;
  } catch (e) {
    attempts.push({ path: 'goodies/holders', collection: label, error: e.message });
    return false;
  }
}

// ---------- Path 2: On-chain via TonAPI (wallet address) ----------
async function tonapiOwnsCollection(walletAddress, collectionAddress, label, attempts) {
  try {
    const url = `https://tonapi.io/v2/accounts/${encodeURIComponent(walletAddress)}/nfts`
              + `?collection=${encodeURIComponent(collectionAddress)}&limit=1`;
    const headers = { 'Accept': 'application/json' };
    if (TONAPI_KEY) headers['Authorization'] = 'Bearer ' + TONAPI_KEY;
    const r = await fetch(url, { headers });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch {}
    const items = (data && Array.isArray(data.nft_items)) ? data.nft_items : [];
    const owns = items.length > 0;
    attempts.push({
      path: 'tonapi/nfts', collection: label,
      status: r.status, owns, nftAddress: owns ? items[0].address : null,
    });
    return owns;
  } catch (e) {
    attempts.push({ path: 'tonapi/nfts', collection: label, error: e.message });
    return false;
  }
}

export default async function handler(req, res) {
  // GET diagnostic — no Goodies traffic, no secrets
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      env: {
        TELEGRAM_BOT_TOKEN: !!BOT_TOKEN,
        GOODIES_USERNAME:   !!GOODIES_USERNAME,
        GOODIES_PASSWORD:   !!GOODIES_PASSWORD,
        TONAPI_KEY:         !!TONAPI_KEY, // optional
      },
      dropId: DROP_ID,
      collections: COLLECTIONS,
      collectionsTon: COLLECTIONS_TON,
      build: 'verify-access v4 (goodies + tonapi onchain)',
    });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = readBody(req);
  const debug = !!body.debug;
  const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';

  const attempts = [];
  let goodiesAvailable = false;
  let telegramUserId = null;

  // Validate Telegram initData if Goodies creds present
  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  if (BOT_TOKEN && GOODIES_USERNAME && GOODIES_PASSWORD && initData) {
    const v = hmacCheck(initData, BOT_TOKEN);
    if (v.ok && v.user?.id) {
      telegramUserId = v.user.id;
      goodiesAvailable = true;
    } else {
      attempts.push({ path: 'initData', error: v.reason || 'invalid' });
    }
  } else if (initData) {
    attempts.push({ path: 'initData', skipped: 'goodies_creds_missing' });
  }

  // Run both paths in parallel
  const tasks = [];

  // Goodies (telegram user id)
  let goodiesDrop = { owner: false };
  let goodiesMai = false, goodiesVi = false;
  if (goodiesAvailable) {
    tasks.push((async () => {
      goodiesDrop = await goodiesVerifyDrop(telegramUserId, attempts);
      if (!goodiesDrop.owner) {
        [goodiesMai, goodiesVi] = await Promise.all([
          goodiesHoldersIncludes(COLLECTIONS.mai, telegramUserId, 'mai', attempts),
          goodiesHoldersIncludes(COLLECTIONS.vi,  telegramUserId, 'vi',  attempts),
        ]);
      }
    })());
  }

  // TonAPI (wallet)
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

  const payload = {
    ok: true,
    hasAccess,
    telegramUserId: telegramUserId ? String(telegramUserId) : null,
    wallet: wallet || null,
    via: {
      goodies: { drop: goodiesDrop.owner, mai: goodiesMai, vi: goodiesVi, available: goodiesAvailable },
      chain:   { mai: chainMai, vi: chainVi, available: !!wallet },
    },
    packAmount: goodiesDrop.packAmount || 0,
  };
  if (debug) payload.attempts = attempts;
  return res.status(200).json(payload);
}
