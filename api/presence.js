// Vercel serverless function: /api/presence
// Tracks who is currently active ("online") in a room and when they were
// last seen there, using the same Upstash Redis as everything else.
//
// The client sends a heartbeat (POST) every ~12 seconds while the chat is
// open. Each heartbeat writes:
//   - vanish:online:<room>:<name>   -> timestamp, with a short TTL
//   - vanish:lastseen:<room>:<name> -> timestamp, no TTL
//   - <name> added to vanish:participants:<room> (a set)
//
// The "online" key expiring on its own (no heartbeat = key disappears)
// is what lets a closed tab/app naturally show as offline again, with no
// separate cleanup step needed.

const ONLINE_TTL_SECONDS = 20;

// How long a name stays in the room's participant set after it was last seen.
// Generous next to the 1-hour message lifetime; it exists only to stop the set
// growing forever and to keep abandoned names out of the "who am I talking to"
// lookup.
const PARTICIPANT_TTL_MS = 24 * 60 * 60 * 1000;

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
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const room = slugRoom(body.room);
      const sender = String(body.sender || '').trim().slice(0, 24);
      if (!room || !sender) {
        return res.status(400).json({ error: 'room and sender are required' });
      }
      const now = Date.now();
      await redis(['SADD', 'vanish:participants:' + room, sender]);
      await redis(['SET', 'vanish:online:' + room + ':' + sender, String(now), 'EX', String(ONLINE_TTL_SECONDS)]);
      await redis(['SET', 'vanish:lastseen:' + room + ':' + sender, String(now)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const room = slugRoom(req.query.room);
      if (!room) return res.status(400).json({ error: 'room is required' });

      const members = (await redis(['SMEMBERS', 'vanish:participants:' + room])) || [];
      const now = Date.now();
      const all = await Promise.all(members.map(async (name) => {
        const [onlineRaw, lastSeenRaw] = await Promise.all([
          redis(['GET', 'vanish:online:' + room + ':' + name]),
          redis(['GET', 'vanish:lastseen:' + room + ':' + name])
        ]);
        return {
          name,
          online: !!onlineRaw,
          lastSeen: lastSeenRaw ? Number(lastSeenRaw) : null
        };
      }));

      // The participants set is append-only, so without this it accumulates
      // every name that ever joined the room — forever, with no TTL. That both
      // grows unboundedly in Redis and lets a long-gone name be picked as "the
      // other person" in the header. Messages only live an hour, so anyone
      // unseen for a day has nothing left here to be part of.
      const stale = all.filter(u => !u.online && (u.lastSeen === null || now - u.lastSeen > PARTICIPANT_TTL_MS));
      if (stale.length) {
        await Promise.all(stale.map(async (u) => {
          await redis(['SREM', 'vanish:participants:' + room, u.name]);
          await redis(['DEL', 'vanish:lastseen:' + room + ':' + u.name]);
        }));
      }

      // Online first, then most recently seen, so a client can take users[0]
      // as the best guess at who it is actually talking to.
      const users = all
        .filter(u => !stale.includes(u))
        .sort((a, b) => (b.online - a.online) || ((b.lastSeen || 0) - (a.lastSeen || 0)));

      return res.status(200).json({ room, users });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
