// Vercel serverless function: /api/sync
// One round trip for everything a client needs to stay current: new messages,
// pending call signals, read receipts, and (optionally) presence.
//
// Why this exists. The client used to poll /api/messages + /api/signal every
// 2s and POST+GET /api/presence every 10s, and fire a separate POST for read
// receipts. Measured on an idle two-person room that is ~3.6 Redis commands
// and ~2.4 function invocations *per second* — ~311,000 Redis commands a day
// with nobody typing. It also re-sent the room's entire message array on every
// single tick, base64 photos and all, which on a phone data plan is the
// difference between usable and not.
//
// This endpoint collapses all of it into one POST that:
//   - returns only messages that changed since `since` (newly sent, or newly
//     seen by the other person), instead of the whole history
//   - returns every current message id so "delete for everyone" is still
//     detectable without shipping the bodies again
//   - folds the presence heartbeat and the presence read into the same call,
//     and only when the client asks for it (`wantPresence`)
//   - applies the caller's read receipts in the same call, so acknowledging a
//     message costs no extra request
//   - uses Upstash's /pipeline endpoint, so N Redis commands cost one HTTP
//     round trip instead of N — that latency was most of the function's
//     wall-clock time, and wall-clock is what Vercel bills
//
// The older endpoints are left untouched and still work: this is purely
// additive, so a client running from a stale service-worker cache keeps going.

const LIFETIME_MS = 60 * 60 * 1000;      // messages, matching /api/messages
const SIGNAL_TTL_MS = 2 * 60 * 1000;     // call signals, matching /api/signal
const ONLINE_TTL_SECONDS = 30;           // no heartbeat for this long => offline
const PARTICIPANT_TTL_MS = 24 * 60 * 60 * 1000;

// `since` is echoed back to the client shifted this far into the past.
//
// Not paranoia — a real race. /api/messages stamps a message's `ts`, then does
// a network round trip to Redis to store it. If our GET lands inside that
// window we don't see the message, yet its `ts` is already older than the
// `now` we hand back as the next `since`, so we would never ask for it again
// and it would be lost for good. Overlapping means we re-send the last few
// seconds every tick; the client dedupes by id, so the only cost is bytes.
const OVERLAP_MS = 5000;

function creds() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars');
  }
  return { url: url.replace(/\/+$/, ''), token };
}

// Runs a batch of commands in a single HTTP request, in order, and returns
// their results positionally.
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const { url, token } = creds();
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmds)
  });
  const data = await r.json();
  // A transport/auth failure comes back as a bare object, a successful
  // pipeline as an array of one {result}/{error} per command.
  if (!Array.isArray(data)) {
    throw new Error((data && data.error) || 'redis pipeline failed');
  }
  return data.map((d) => {
    if (d && d.error) throw new Error(d.error);
    return d ? d.result : null;
  });
}

function slugRoom(r) {
  return String(r || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
}

function parseArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Nothing here is ever worth revalidating from a cache — every field is a
  // point-in-time answer.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const room = slugRoom(body.room);
    const sender = String(body.sender || '').trim().slice(0, 24);
    if (!room) return res.status(400).json({ error: 'room is required' });

    const since = Number.isFinite(body.since) ? Number(body.since) : 0;
    const wantPresence = !!body.wantPresence && !!sender;
    const seenIds = Array.isArray(body.seenIds) ? body.seenIds.slice(0, 200).map(String) : [];
    const now = Date.now();

    const msgKey = 'vanish:' + room;
    const sigKey = 'vanish:signal:' + room;
    const partKey = 'vanish:participants:' + room;

    // --- one round trip: both reads, plus the heartbeat writes if asked ---
    // SMEMBERS is queued after SADD deliberately: the pipeline runs in order,
    // so the caller is already in the set it reads back.
    const batch = [['GET', msgKey], ['GET', sigKey]];
    if (wantPresence) {
      batch.push(['SADD', partKey, sender]);
      batch.push(['SET', 'vanish:online:' + room + ':' + sender, String(now), 'EX', String(ONLINE_TTL_SECONDS)]);
      batch.push(['SET', 'vanish:lastseen:' + room + ':' + sender, String(now)]);
      batch.push(['SMEMBERS', partKey]);
    }
    const head = await pipeline(batch);

    const storedMsgs = parseArray(head[0]);
    const storedSigs = parseArray(head[1]);
    const members = wantPresence ? (head[5] || []) : [];

    const msgs = storedMsgs.filter((m) => m && now - m.ts < LIFETIME_MS);
    const sigs = storedSigs.filter((s) => s && now - s.ts < SIGNAL_TTL_MS);

    // Deferred until the end so expiry trimming, receipt writes and participant
    // pruning all land in a single second round trip.
    const writes = [];
    if (msgs.length !== storedMsgs.length) writes.push(['SET', msgKey, JSON.stringify(msgs)]);
    if (sigs.length !== storedSigs.length) writes.push(['SET', sigKey, JSON.stringify(sigs)]);

    // --- read receipts, in-band ---
    let receiptChanged = false;
    if (seenIds.length && sender) {
      const wanted = new Set(seenIds);
      for (const m of msgs) {
        if (!wanted.has(m.id) || m.sender === sender) continue;
        m.seenBy = m.seenBy || [];
        if (!m.seenBy.some((s) => s.name === sender)) {
          m.seenBy.push({ name: sender, ts: now });
          receiptChanged = true;
        }
      }
      if (receiptChanged) {
        // Replace rather than add a second SET for the same key.
        const at = writes.findIndex((w) => w[0] === 'SET' && w[1] === msgKey);
        if (at >= 0) writes[at] = ['SET', msgKey, JSON.stringify(msgs)];
        else writes.push(['SET', msgKey, JSON.stringify(msgs)]);
      }
    }

    // --- presence ---
    let users = null;
    if (wantPresence) {
      if (members.length) {
        // Two MGETs instead of two GETs per member: the old /api/presence cost
        // 1 + 2N commands and 1 + 2N round trips just to render one name.
        const [onlineVals, lastVals] = await pipeline([
          ['MGET'].concat(members.map((n) => 'vanish:online:' + room + ':' + n)),
          ['MGET'].concat(members.map((n) => 'vanish:lastseen:' + room + ':' + n))
        ]);
        const all = members.map((name, i) => ({
          name,
          online: !!(onlineVals && onlineVals[i]),
          lastSeen: (lastVals && lastVals[i]) ? Number(lastVals[i]) : null
        }));

        // The participant set is append-only with no TTL, so left alone it
        // accumulates every name that ever joined and lets a long-gone one be
        // picked as "the other person". Messages only last an hour, so anyone
        // unseen for a day has nothing here to be part of.
        const stale = all.filter((u) => !u.online && (u.lastSeen === null || now - u.lastSeen > PARTICIPANT_TTL_MS));
        const staleNames = new Set(stale.map((u) => u.name));
        for (const u of stale) {
          writes.push(['SREM', partKey, u.name]);
          writes.push(['DEL', 'vanish:lastseen:' + room + ':' + u.name]);
        }

        // Online first, then most recently seen, so the client can trust the
        // head of the list as its best guess at who it is talking to.
        users = all
          .filter((u) => !staleNames.has(u.name))
          .sort((a, b) => (b.online - a.online) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
      } else {
        users = [];
      }
    }

    if (writes.length) await pipeline(writes);

    // A message counts as changed if it is new, or if *someone else* has read
    // it since we last asked. Excluding our own receipts matters: we just wrote
    // them a few lines up, so counting them would echo every message we
    // received straight back to us on the next tick.
    const changed = msgs.filter((m) =>
      m.ts > since || (m.seenBy || []).some((s) => s.ts > since && s.name !== sender)
    );

    return res.status(200).json({
      now,
      nextSince: Math.max(0, now - OVERLAP_MS),
      messages: changed,
      ids: msgs.map((m) => m.id),
      signals: sigs,
      users
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
