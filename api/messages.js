// Vercel serverless function: /api/messages
// Stores each room's messages as one JSON array in Upstash Redis (free tier).
// Anything older than LIFETIME_MS is filtered out on every read, and written
// back trimmed, so nothing lingers past an hour.
//
// On POST, it also sends a real Web Push notification (if VAPID env vars
// are set) to anyone in the room who has subscribed via /api/subscribe —
// this is what lets a message reach a closed/backgrounded app, including
// an installed iPhone home-screen app.

const webpush = require('web-push');

const LIFETIME_MS = 60 * 60 * 1000; // 1 hour
const MAX_IMAGE_B64_LENGTH = 600000; // Upstash's free tier caps request/value size around 1MB —
                                      // this leaves headroom for the rest of the room's message history
const MAX_AUDIO_B64_LENGTH = 600000; // voice messages are recorded at a low bitrate client-side,
                                      // so this comfortably covers a couple of minutes of speech

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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

async function notifySubscribers(room, sender, previewText) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // push not configured yet

  try {
    const setKey = 'vanish:subs:' + room;
    const members = await redis(['SMEMBERS', setKey]);
    if (!members || !members.length) return;

    const payload = JSON.stringify({
      title: sender,
      body: previewText.length > 120 ? previewText.slice(0, 120) + '…' : previewText,
      room
    });

    await Promise.all(members.filter(name => name !== sender).map(async (name) => {
      const subKey = 'vanish:sub:' + room + ':' + name;
      const raw = await redis(['GET', subKey]);
      if (!raw) return;
      const subscription = JSON.parse(raw);
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // subscription is dead (user revoked, uninstalled, etc.) — clean up
          await redis(['DEL', subKey]);
          await redis(['SREM', setKey, name]);
        }
      }
    }));
  } catch (err) {
    // never let a push failure break sending the actual message
    console.error('push notify failed:', err.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

    if (req.method === 'DELETE') {
      // "Delete for everyone" — actually removes the message from the
      // room's stored array, so it disappears from both people's screens
      // on their next poll (see reconcileDeleted() client-side).
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const room = slugRoom(body.room);
      const id = String(body.id || '').slice(0, 64);
      const sender = String(body.sender || '').trim().slice(0, 24);
      if (!room || !id || !sender) {
        return res.status(400).json({ error: 'room, id and sender are required' });
      }

      const key = 'vanish:' + room;
      const raw = await redis(['GET', key]);
      let arr = raw ? JSON.parse(raw) : [];

      const target = arr.find(m => m.id === id);
      if (!target) {
        // Already gone (expired, or already deleted) — treat as success,
        // since the end state the client wants is "this message is gone".
        return res.status(200).json({ ok: true });
      }
      if (target.sender !== sender) {
        return res.status(403).json({ error: 'only the sender can delete this for everyone' });
      }

      const next = arr.filter(m => m.id !== id);
      await redis(['SET', key, JSON.stringify(next)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

      // ---- mark messages as seen (read receipts) ----
      if (body.action === 'seen') {
        const room = slugRoom(body.room);
        const viewer = String(body.viewer || '').trim().slice(0, 24);
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : [];
        if (!room || !viewer || !ids.length) {
          return res.status(400).json({ error: 'room, viewer and ids are required' });
        }
        const key = 'vanish:' + room;
        const raw = await redis(['GET', key]);
        let arr = raw ? JSON.parse(raw) : [];
        const now = Date.now();
        let changed = false;
        arr = arr.map(m => {
          if (ids.includes(m.id) && m.sender !== viewer) {
            m.seenBy = m.seenBy || [];
            if (!m.seenBy.some(s => s.name === viewer)) {
              m.seenBy.push({ name: viewer, ts: now });
              changed = true;
            }
          }
          return m;
        });
        if (changed) await redis(['SET', key, JSON.stringify(arr)]);
        return res.status(200).json({ ok: true });
      }

      // ---- send a new message (text, and/or a single image or voice note) ----
      const room = slugRoom(body.room);
      const sender = String(body.sender || '').trim().slice(0, 24);
      const text = String(body.text || '').trim().slice(0, 1000);
      const image = typeof body.image === 'string' && body.image ? body.image : null;
      const audio = typeof body.audio === 'string' && body.audio ? body.audio : null;
      // Accept either field name: the client has historically posted
      // `audioDuration`, while this endpoint reads `duration`. Taking both
      // keeps old and new clients working instead of silently dropping the
      // length and rendering every voice note as 0:00.
      const rawDuration = Number.isFinite(body.duration) ? body.duration
        : (Number.isFinite(body.audioDuration) ? body.audioDuration : null);
      const duration = rawDuration === null ? null : Math.max(0, Math.min(600, Math.round(rawDuration)));

      if (!room || !sender || (!text && !image && !audio)) {
        return res.status(400).json({ error: 'room, sender and text, image or audio are required' });
      }
      if (image) {
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(image)) {
          return res.status(400).json({ error: 'unsupported image format' });
        }
        if (image.length > MAX_IMAGE_B64_LENGTH) {
          return res.status(400).json({ error: 'image too large' });
        }
      }
      if (audio) {
        if (!/^data:audio\/(webm|ogg|mp4|mpeg|mp3|aac|x-m4a|wav)(;codecs=[a-zA-Z0-9.,\-]+)?;base64,/i.test(audio)) {
          return res.status(400).json({ error: 'unsupported audio format' });
        }
        if (audio.length > MAX_AUDIO_B64_LENGTH) {
          return res.status(400).json({ error: 'voice message too long' });
        }
      }
      const key = 'vanish:' + room;

      const raw = await redis(['GET', key]);
      let arr = raw ? JSON.parse(raw) : [];
      const now = Date.now();
      arr = arr.filter(m => now - m.ts < LIFETIME_MS);

      let replyTo = null;
      if (body.replyTo && body.replyTo.id) {
        replyTo = {
          id: String(body.replyTo.id).slice(0, 64),
          sender: String(body.replyTo.sender || '').trim().slice(0, 24),
          text: String(body.replyTo.text || '').trim().slice(0, 120)
        };
      }

      const msg = {
        id: now + '-' + Math.random().toString(36).slice(2, 8),
        sender,
        text,
        image,
        audio,
        duration,
        type: image ? 'image' : (audio ? 'audio' : 'text'),
        ts: now,
        replyTo,
        seenBy: [] // filled in by the 'seen' action above once the other person views it
      };
      arr.push(msg);
      await redis(['SET', key, JSON.stringify(arr)]);

      const preview = image ? (text || '📷 Photo') : (audio ? '🎤 Voice message' : text);
      await notifySubscribers(room, sender, preview);

      return res.status(200).json(msg);
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
