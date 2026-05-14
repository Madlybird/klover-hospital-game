// Verify whether the given TON wallet holds at least one NFT from the
// MAI Nurse or VI Rx collection via the Goodies partner API.
//
// Credentials live ONLY in Vercel env vars (GOODIES_USERNAME +
// GOODIES_PASSWORD). They never reach the browser bundle.

const COLLECTIONS = {
  mai: '5b909f0d-4f30-49bf-ad3a-da131a85fa56',
  vi:  '9c26b8ac-8fd4-4d49-91d7-f9bdcd0e6ec4',
};

const GOODIES_BASE = 'https://api-goodies.cleeviox.com/api/partner';

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

function truthyOwnership(payload) {
  if (!payload || typeof payload !== 'object') return false;
  // Try every reasonable response shape so the client doesn't break on
  // a documentation change.
  if (payload.owned === true) return true;
  if (payload.isOwner === true) return true;
  if (payload.hasOwnership === true) return true;
  if (payload.ownership === true) return true;
  if (typeof payload.count === 'number' && payload.count > 0) return true;
  if (typeof payload.amount === 'number' && payload.amount > 0) return true;
  if (Array.isArray(payload.items) && payload.items.length > 0) return true;
  if (Array.isArray(payload.nfts) && payload.nfts.length > 0) return true;
  return false;
}

async function checkCollection(collectionId, wallet, authHeader) {
  // Primary path: POST /partner/verify-ownership
  try {
    const r = await fetch(`${GOODIES_BASE}/verify-ownership`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ walletAddress: wallet, collectionId }),
    });
    if (r.ok) {
      const data = await r.json();
      return { ok: true, owned: truthyOwnership(data), source: 'verify-ownership' };
    }
    // 404 / 405 → fall through to holders list
    if (r.status !== 404 && r.status !== 405) {
      const txt = await r.text().catch(() => '');
      console.warn('[verify-access] verify-ownership non-ok', r.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.warn('[verify-access] verify-ownership threw:', e.message);
  }

  // Fallback: GET /partner/holders?collectionId=...
  try {
    const url = `${GOODIES_BASE}/holders?collectionId=${encodeURIComponent(collectionId)}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
      },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[verify-access] holders non-ok', r.status, txt.slice(0, 200));
      return { ok: false, owned: false, source: 'holders', status: r.status };
    }
    const data = await r.json();
    const list = Array.isArray(data) ? data
              : Array.isArray(data.holders) ? data.holders
              : Array.isArray(data.items) ? data.items
              : Array.isArray(data.data) ? data.data : [];
    const target = String(wallet).trim().toLowerCase();
    const owned = list.some((h) => {
      const addr = (h && (h.walletAddress || h.address || h.wallet || h.owner)) || '';
      return String(addr).trim().toLowerCase() === target;
    });
    return { ok: true, owned, source: 'holders' };
  } catch (e) {
    console.warn('[verify-access] holders threw:', e.message);
    return { ok: false, owned: false, error: e.message };
  }
}

export default async function handler(req, res) {
  // Diagnostic GET — confirms env wiring without leaking secrets
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      env: {
        GOODIES_USERNAME: !!process.env.GOODIES_USERNAME,
        GOODIES_PASSWORD: !!process.env.GOODIES_PASSWORD,
      },
      collections: Object.keys(COLLECTIONS),
      build: 'verify-access v1',
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
  if (!wallet || typeof wallet !== 'string') {
    return res.status(400).json({ error: 'no_wallet' });
  }

  const [mai, vi] = await Promise.all([
    checkCollection(COLLECTIONS.mai, wallet, authHeader),
    checkCollection(COLLECTIONS.vi,  wallet, authHeader),
  ]);

  const hasAccess = !!(mai.owned || vi.owned);

  return res.status(200).json({
    ok: true,
    hasAccess,
    mai: mai.owned,
    vi:  vi.owned,
    // useful when debugging which path matched, without leaking creds
    sources: { mai: mai.source, vi: vi.source },
  });
}
