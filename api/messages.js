// Vercel serverless function: /api/messages
// Stores each room's messages as one JSON array in Upstash Redis (free tier).
// Anything older than LIFETIME_MS is filtered out on every read, and written
// back trimmed, so nothing lingers past an hour.

const LIFETIME_MS = 60 * 60 * 1000; // 1 hour

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const room = slugRoom(req.query.room);
      if (!room) return res.status(400).json({ error: 'room is required' });
      const key = 'vanish:' + room;

      const raw = await redis(['GET', key]);
      let arr = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      const fresh = arr.filter(m => now - m.ts < LIFETIME_MS);
      if (fresh.length !== arr.length) {
        await redis(['SET', key, JSON.stringify(fresh)]);
      }
      return res.status(200).json(fresh);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const room = slugRoom(body.room);
      const sender = String(body.sender || '').trim().slice(0, 24);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!room || !sender || !text) {
        return res.status(400).json({ error: 'room, sender and text are required' });
      }
      const key = 'vanish:' + room;

      const raw = await redis(['GET', key]);
      let arr = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      arr = arr.filter(m => now - m.ts < LIFETIME_MS);

      const msg = {
        id: now + '-' + Math.random().toString(36).slice(2, 8),
        sender,
        text,
        ts: now
      };
      arr.push(msg);
      await redis(['SET', key, JSON.stringify(arr)]);
      return res.status(200).json(msg);
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
