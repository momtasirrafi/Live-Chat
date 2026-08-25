// Vercel serverless function: /api/vapid
// Hands the client the VAPID *public* key so it can call
// pushManager.subscribe().
//
// The key used to be pasted into index.html as a literal, which meant push was
// silently disabled until someone remembered to edit the HTML as well as the
// Vercel env vars — and in this repo nobody had, so the placeholder was still
// sitting there and notifications never worked. One source of truth instead.
//
// A VAPID public key is designed to be public: it is what identifies the
// application server to the browser's push service, and it ships to every
// client that subscribes. Only VAPID_PRIVATE_KEY is a secret, and it never
// leaves the server.
//
// Generate a pair with:  npx web-push generate-vapid-keys
// then set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in Vercel.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.VAPID_PUBLIC_KEY || '';
  const configured = !!key && key.indexOf('PASTE_YOUR') !== 0;

  // Safe to cache briefly — the key only changes if the operator rotates it,
  // and a stale one for a few minutes just means a delayed re-subscribe.
  res.setHeader('Cache-Control', configured ? 'public, max-age=300' : 'no-store');
  return res.status(200).json({ publicKey: configured ? key : null, configured });
};
