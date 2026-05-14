// Verify whether the current Telegram user owns a pack from our drop
// (or a unwrapped pack from MAI Nurse / VI Rx collections) via the
// Goodies partner API.
//
// Goodies works by Telegram user ID, not by TON wallet — so we
// authenticate the caller from the Telegram WebApp initData header,
// then ask Goodies. Wallet connect is irrelevant to access checks.
//
// All Goodies credentials and the bot token live ONLY in Vercel env
// vars; nothing reaches the browser bundle.

import crypto from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOODIES_USERNAME = process.env.GOODIES_USERNAME;
const GOODIES_PASSWORD = process.env.GOODIES_PASSWORD;

const GOODIES_BASE = 'https://api-goodies.cleeviox.com/partner';
const DROP_ID = '9ee95390-b12a-428a-8ca8-8855059315f5';
const COLLECTIONS = {
  mai: '5b909f0d-4f30-49bf-ad3a-da131a85fa56',
  vi:  '9c26b8ac-8fd4-4d49-91d7-f9bdcd0e6ec4',
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

function authHeader() {
  return 'Basic ' + Buffer.from(`${GOODIES_USERNAME}:${GOODIES_PASSWORD}`).toString('base64');
}

async function verifyDropOwnership(telegramUserId, attempts) {
  try {
    const r = await fetch(`${GOODIES_BASE}/verify-ownership`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader(),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ dropId: DROP_ID, telegramUserId: String(telegramUserId) }),
    });
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt); } catch {}
    attempts.push({ endpoint: 'POST /partner/verify-ownership', dropId: DROP_ID, status: r.status, response: data || txt.slice(0, 300) });
    if (r.ok && data && data.isOwner === true) {
      return { owner: true, packAmount: data.packAmount, source: 'drop' };
    }
  } catch (e) {
    attempts.push({ endpoint: 'POST /partner/verify-ownership', error: e.message });
  }
  return { owner: false };
}

async function holdersIncludes(collectionId, telegramUserId, label, attempts) {
  try {
    const url = `${GOODIES_BASE}/holders?collectionId=${encodeURIComponent(collectionId)}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': authHeader(), 'Accept': 'application/json' },
    });
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt); } catch {}
    const ids = (data && Array.isArray(data.telegramUserIds)) ? data.telegramUserIds : [];
    const hit = ids.some((x) => String(x) === String(telegramUserId));
    attempts.push({
      endpoint: 'GET /partner/holders',
      collection: label,
      collectionId,
      status: r.status,
      holderCount: data && typeof data.count === 'number' ? data.count : ids.length,
      matched: hit,
    });
    return hit;
  } catch (e) {
    attempts.push({ endpoint: 'GET /partner/holders', collection: label, error: e.message });
    return false;
  }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  // GET diagnostic — no secrets, no Goodies traffic
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      env: {
        TELEGRAM_BOT_TOKEN: !!BOT_TOKEN,
        GOODIES_USERNAME:   !!GOODIES_USERNAME,
        GOODIES_PASSWORD:   !!GOODIES_PASSWORD,
      },
      dropId: DROP_ID,
      collections: COLLECTIONS,
      build: 'verify-access v3 (telegram-id based)',
    });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!BOT_TOKEN || !GOODIES_USERNAME || !GOODIES_PASSWORD) {
    return res.status(500).json({
      error: 'server_not_configured',
      env: {
        TELEGRAM_BOT_TOKEN: !!BOT_TOKEN,
        GOODIES_USERNAME:   !!GOODIES_USERNAME,
        GOODIES_PASSWORD:   !!GOODIES_PASSWORD,
      },
    });
  }

  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'no_init_data' });
  const v = hmacCheck(initData, BOT_TOKEN);
  if (!v.ok) return res.status(401).json({ error: 'verify_failed', reason: v.reason });

  const telegramUserId = v.user?.id;
  if (!telegramUserId) return res.status(401).json({ error: 'no_user_id' });

  const body = readBody(req);
  const debug = !!body.debug;
  const attempts = [];

  // Primary: drop ownership
  const drop = await verifyDropOwnership(telegramUserId, attempts);

  // Belt-and-suspenders: also check both collection holder lists,
  // so users who hold MAI/VI from outside the drop still pass.
  let mai = false;
  let vi  = false;
  if (!drop.owner) {
    [mai, vi] = await Promise.all([
      holdersIncludes(COLLECTIONS.mai, telegramUserId, 'mai', attempts),
      holdersIncludes(COLLECTIONS.vi,  telegramUserId, 'vi',  attempts),
    ]);
  }

  const hasAccess = drop.owner || mai || vi;
  const payload = {
    ok: true,
    hasAccess,
    telegramUserId: String(telegramUserId),
    drop: drop.owner,
    mai,
    vi,
    packAmount: drop.packAmount || 0,
  };
  if (debug) payload.attempts = attempts;
  return res.status(200).json(payload);
}
