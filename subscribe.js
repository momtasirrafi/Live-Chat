// Vercel serverless function: /api/subscribe
// Stores Web Push subscriptions so /api/messages can notify people even
// when the app isn't open. On iPhone this only works if the app was added
// to the Home Screen and opened from that icon (iOS 16.4+) — Safari tabs
// can't receive background push.

async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars');
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmd)
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function slugRoom(r) {
  return String(r || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const room = slugRoom(body.room);
    const sender = String(body.sender || '').trim().slice(0, 24);
    if (!room || !sender) {
      return res.status(400).json({ error: 'room and sender are required' });
    }

    const subKey = 'vanish:sub:' + room + ':' + sender;
    const setKey = 'vanish:subs:' + room;

    if (req.method === 'POST') {
      if (!body.subscription) {
        return res.status(400).json({ error: 'subscription is required' });
      }
      await redis(['SET', subKey, JSON.stringify(body.subscription)]);
      await redis(['SADD', setKey, sender]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await redis(['DEL', subKey]);
      await redis(['SREM', setKey, sender]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
