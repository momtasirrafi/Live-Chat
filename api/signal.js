// Vercel serverless function: /api/signal
// Relays WebRTC signaling messages (offer/answer/candidate/hangup/decline)
// between the two people in a room, using the same Upstash Redis used for
// chat messages. Signals are short-lived — trimmed after 2 minutes, since
// a call handshake only needs seconds to complete.

const SIGNAL_TTL_MS = 2 * 60 * 1000; // 2 minutes

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
      const key = 'vanish:signal:' + room;

      const raw = await redis(['GET', key]);
      let arr = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      const fresh = arr.filter(s => now - s.ts < SIGNAL_TTL_MS);
      if (fresh.length !== arr.length) {
        await redis(['SET', key, JSON.stringify(fresh)]);
      }
      return res.status(200).json(fresh);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const room = slugRoom(body.room);
      const sender = String(body.sender || '').trim().slice(0, 24);
      const type = String(body.type || '');
      const callId = String(body.callId || '');
      if (!room || !sender || !type || !callId) {
        return res.status(400).json({ error: 'room, sender, type and callId are required' });
      }
      const key = 'vanish:signal:' + room;

      const raw = await redis(['GET', key]);
      let arr = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      arr = arr.filter(s => now - s.ts < SIGNAL_TTL_MS);

      const sig = {
        id: now + '-' + Math.random().toString(36).slice(2, 8),
        sender,
        type,          // 'offer' | 'answer' | 'candidate' | 'hangup' | 'decline' | 'busy'
        callId,
        callType: body.callType || null, // 'audio' | 'video'
        sdp: body.sdp || null,
        candidate: body.candidate || null,
        ts: now
      };
      arr.push(sig);
      await redis(['SET', key, JSON.stringify(arr)]);
      return res.status(200).json(sig);
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
