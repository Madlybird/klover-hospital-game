// Verify whether the given TON wallet holds at least one NFT from the
// MAI Nurse or VI Rx collection via the Goodies partner API.
//
// Credentials live ONLY in Vercel env vars (GOODIES_USERNAME +
// GOODIES_PASSWORD). They never reach the browser bundle.
//
// Diagnostic mode:
//   GET  /api/verify-access?debug=1&wallet=<addr>   → full breakdown
//   POST /api/verify-access  body:{wallet, debug:true} → full breakdown

const COLLECTIONS = {
  mai: '5b909f0d-4f30-49bf-ad3a-da131a85fa56',
  vi:  '9c26b8ac-8fd4-4d49-91d7-f9bdcd0e6ec4',
};

const GOODIES_BASE = 'https://api-goodies.cleeviox.com/api/partner';

// ---------- TON address helpers ----------
// Convert raw "wc:hex" to user-friendly base64url (EQ/UQ format).
function crc16(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function rawToFriendly(raw, bounceable = true) {
  if (typeof raw !== 'string' || !raw.includes(':')) return null;
  const [wcStr, hexStr] = raw.split(':');
  if (!hexStr || hexStr.length !== 64) return null;
  const workchain = parseInt(wcStr, 10);
  if (Number.isNaN(workchain)) return null;
  const tag = bounceable ? 0x11 : 0x51;
  const wcByte = workchain === -1 ? 0xff : (workchain & 0xff);
  const bytes = new Uint8Array(36);
  bytes[0] = tag;
  bytes[1] = wcByte;
  for (let i = 0; i < 32; i++) {
    bytes[2 + i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  const crc = crc16(bytes.slice(0, 34));
  bytes[34] = (crc >> 8) & 0xff;
  bytes[35] = crc & 0xff;
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// Generate every plausible representation of a wallet address so the
// Goodies query matches regardless of how their DB stored it.
function addressVariants(input) {
  if (!input || typeof input !== 'string') return [];
  const trimmed = input.trim();
  const out = new Set([trimmed]);
  if (trimmed.includes(':')) {
    const bouncable = rawToFriendly(trimmed, true);
    const nonBouncable = rawToFriendly(trimmed, false);
    if (bouncable) out.add(bouncable);
    if (nonBouncable) out.add(nonBouncable);
  } else if (/^[A-Za-z0-9_-]{48}$/.test(trimmed)) {
    // Already friendly — could try lowercase variant too, but Goodies
    // is case-sensitive; just leave it.
    out.add(trimmed);
  }
  return [...out];
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

function truthyOwnership(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.owned === true) return true;
  if (payload.isOwner === true) return true;
  if (payload.hasOwnership === true) return true;
  if (payload.ownership === true) return true;
  if (payload.holds === true) return true;
  if (payload.result === true) return true;
  if (typeof payload.count === 'number' && payload.count > 0) return true;
  if (typeof payload.amount === 'number' && payload.amount > 0) return true;
  if (typeof payload.balance === 'number' && payload.balance > 0) return true;
  if (Array.isArray(payload.items) && payload.items.length > 0) return true;
  if (Array.isArray(payload.nfts) && payload.nfts.length > 0) return true;
  if (Array.isArray(payload.data) && payload.data.length > 0) return true;
  return false;
}

// Single Goodies call: tries POST verify-ownership with a few body
// shapes, then falls back to GET holders. Each attempt is recorded.
async function checkCollection(collectionId, walletVariants, authHeader, attempts) {
  // 1) POST verify-ownership with different body fields
  const bodyShapes = (variant) => ([
    { walletAddress: variant, collectionId },
    { address:       variant, collectionId },
    { wallet:        variant, collectionId },
    { walletAddress: variant, collectionIds: [collectionId] },
  ]);

  for (const variant of walletVariants) {
    for (const body of bodyShapes(variant)) {
      try {
        const r = await fetch(`${GOODIES_BASE}/verify-ownership`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const txt = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch {}
        attempts.push({
          endpoint: 'POST /verify-ownership',
          bodyKey: Object.keys(body).join(','),
          variant,
          status: r.status,
          response: parsed || txt.slice(0, 400),
        });
        if (r.ok && truthyOwnership(parsed)) {
          return { owned: true, source: 'verify-ownership' };
        }
      } catch (e) {
        attempts.push({
          endpoint: 'POST /verify-ownership',
          bodyKey: Object.keys(body).join(','),
          variant,
          error: e.message,
        });
      }
    }
  }

  // 2) GET holders list and try to match the address
  try {
    const url = `${GOODIES_BASE}/holders?collectionId=${encodeURIComponent(collectionId)}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
    });
    const txt = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch {}
    attempts.push({
      endpoint: 'GET /holders',
      status: r.status,
      sample: Array.isArray(parsed) ? parsed.slice(0, 2)
            : (parsed && parsed.holders ? parsed.holders.slice(0, 2)
            : parsed && parsed.items   ? parsed.items.slice(0, 2)
            : parsed && parsed.data    ? parsed.data.slice(0, 2)
            : txt.slice(0, 400)),
      totalShape: parsed ? (Array.isArray(parsed) ? 'array' : Object.keys(parsed).slice(0, 8)) : null,
    });

    if (r.ok && parsed) {
      const list = Array.isArray(parsed) ? parsed
                 : Array.isArray(parsed.holders) ? parsed.holders
                 : Array.isArray(parsed.items)   ? parsed.items
                 : Array.isArray(parsed.data)    ? parsed.data : [];

      const targets = new Set(walletVariants.map(v => v.trim().toLowerCase()));
      const owned = list.some((h) => {
        const addr = (h && (h.walletAddress || h.address || h.wallet || h.owner || h)) || '';
        return targets.has(String(addr).trim().toLowerCase());
      });
      if (owned) return { owned: true, source: 'holders' };
    }
  } catch (e) {
    attempts.push({ endpoint: 'GET /holders', error: e.message });
  }

  return { owned: false };
}

export default async function handler(req, res) {
  const debugFlag = (req.query && (req.query.debug === '1' || req.query.debug === 'true'));

  // GET diagnostic
  if (req.method === 'GET') {
    const u = process.env.GOODIES_USERNAME;
    const p = process.env.GOODIES_PASSWORD;

    if (debugFlag && req.query && req.query.wallet) {
      if (!u || !p) return res.status(500).json({ error: 'partner_creds_missing' });
      const authHeader = 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
      const wallet = String(req.query.wallet);
      const variants = addressVariants(wallet);
      const attemptsMai = [];
      const attemptsVi  = [];
      const [mai, vi] = await Promise.all([
        checkCollection(COLLECTIONS.mai, variants, authHeader, attemptsMai),
        checkCollection(COLLECTIONS.vi,  variants, authHeader, attemptsVi),
      ]);
      return res.status(200).json({
        ok: true,
        wallet,
        variants,
        hasAccess: !!(mai.owned || vi.owned),
        mai, vi,
        attempts: { mai: attemptsMai, vi: attemptsVi },
      });
    }

    return res.status(200).json({
      ok: true,
      env: { GOODIES_USERNAME: !!u, GOODIES_PASSWORD: !!p },
      collections: COLLECTIONS,
      build: 'verify-access v2',
      hint: 'Add ?debug=1&wallet=<addr> to see full Goodies trace',
    });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const u = process.env.GOODIES_USERNAME;
  const p = process.env.GOODIES_PASSWORD;
  if (!u || !p) {
    return res.status(500).json({ error: 'partner_creds_missing' });
  }
  const authHeader = 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

  const body = readBody(req);
  const wallet = body.wallet || body.walletAddress || body.address;
  const debug = !!body.debug || debugFlag;
  if (!wallet || typeof wallet !== 'string') {
    return res.status(400).json({ error: 'no_wallet' });
  }

  const variants = addressVariants(wallet);
  const attemptsMai = [];
  const attemptsVi  = [];
  const [mai, vi] = await Promise.all([
    checkCollection(COLLECTIONS.mai, variants, authHeader, attemptsMai),
    checkCollection(COLLECTIONS.vi,  variants, authHeader, attemptsVi),
  ]);
  const hasAccess = !!(mai.owned || vi.owned);

  const payload = {
    ok: true,
    hasAccess,
    mai: mai.owned,
    vi:  vi.owned,
    variants,
  };
  if (debug) payload.attempts = { mai: attemptsMai, vi: attemptsVi };
  return res.status(200).json(payload);
}
