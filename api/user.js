import crypto from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

// Progress is stored in localStorage only — no server persistence needed.
// This endpoint just validates the user and returns an empty shell so the
// client's Sync module doesn't break.
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  const user = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!user || !user.id) {
    return res.status(200).json({ user: null, degraded: 'no_auth' });
  }

  return res.status(200).json({ user: { telegram_id: user.id } });
}
