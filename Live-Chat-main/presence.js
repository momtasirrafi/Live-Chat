// Vercel serverless function: /api/presence
// Tracks who is currently active ("online") in a room, when they were last
// seen, whether they're currently typing, and relays a one-shot "took a
// screenshot" flag — all using the same Upstash Redis as everything else.
//
// The client sends a heartbeat (POST) every few seconds while the chat is
// open. Each heartbeat writes:
//   - vanish:online:<room>:<name>     -> timestamp, short TTL (drives "online")
//   - vanish:lastseen:<room>:<name>   -> timestamp, no TTL
//   - vanish:typing:<room>:<name>     -> '1', very short TTL (drives "typing…")
//   - vanish:screenshot:<room>:<name> -> '1', short TTL, one-shot
//   - <name> added to vanish:participants:<room> (a set)
//
// Keys expiring on their own (no heartbeat/no fresh signal = key vanishes)
// is what lets "online"/"typing" naturally clear with no separate cleanup.

const ONLINE_TTL_SECONDS = 20;
const TYPING_TTL_SECONDS = 5;
const SCREENSHOT_TTL_SECONDS = 8;

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

      // typing === true sets/refreshes a short-lived flag; typing === false
      // clears it immediately (so "stopped typing" reflects right away
      // instead of waiting out the TTL).
      if (body.typing === true) {
        await redis(['SET', 'vanish:typing:' + room + ':' + sender, '1', 'EX', String(TYPING_TTL_SECONDS)]);
      } else if (body.typing === false) {
        await redis(['DEL', 'vanish:typing:' + room + ':' + sender]);
      }

      // One-shot "I think a screenshot was just taken" flag. It's read
      // (and consumed) by the *other* person's next GET — see below.
      if (body.screenshot === true) {
        await redis(['SET', 'vanish:screenshot:' + room + ':' + sender, '1', 'EX', String(SCREENSHOT_TTL_SECONDS)]);
      }

      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const room = slugRoom(req.query.room);
      if (!room) return res.status(400).json({ error: 'room is required' });
      // Optional: who is asking. Used only to decide whether a screenshot
      // flag belongs to "me" (skip/keep) or to the other person (deliver
      // it once, then consume it) — see below.
      const viewer = String(req.query.viewer || '').trim().slice(0, 24);

      const members = (await redis(['SMEMBERS', 'vanish:participants:' + room])) || [];
      const users = await Promise.all(members.map(async (name) => {
        const [onlineRaw, lastSeenRaw, typingRaw, screenshotRaw] = await Promise.all([
          redis(['GET', 'vanish:online:' + room + ':' + name]),
          redis(['GET', 'vanish:lastseen:' + room + ':' + name]),
          redis(['GET', 'vanish:typing:' + room + ':' + name]),
          redis(['GET', 'vanish:screenshot:' + room + ':' + name])
        ]);

        let screenshot = false;
        if (screenshotRaw && viewer && name !== viewer) {
          // Deliver this "took a screenshot" flag to the person asking
          // (since it isn't theirs), then consume it so it only fires once.
          screenshot = true;
          await redis(['DEL', 'vanish:screenshot:' + room + ':' + name]);
        }

        return {
          name,
          online: !!onlineRaw,
          lastSeen: lastSeenRaw ? Number(lastSeenRaw) : null,
          typing: !!typingRaw,
          screenshot
        };
      }));
      return res.status(200).json({ room, users });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
