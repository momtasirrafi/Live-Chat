// Vercel serverless function: /api/turn
// Mints short-lived TURN credentials from Cloudflare Realtime, so the
// long-lived secret (TURN_KEY_API_TOKEN) never has to reach the browser —
// Cloudflare's own docs require this stay server-side, unlike some other
// TURN providers whose API key is safe to use directly from client JS.
//
// Setup (free, no card required):
//   1. Cloudflare dashboard -> Realtime -> TURN Server -> Create.
//   2. Copy the Turn Token ID and API Token it gives you.
//   3. In Vercel -> Settings -> Environment Variables, add:
//        TURN_KEY_ID = the Turn Token ID
//        TURN_KEY_API_TOKEN = the API Token
//      Then redeploy.
//
// If these env vars aren't set, this returns 404 so the client falls back
// to whatever other TURN option it has configured (see index.html).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const keyId = process.env.TURN_KEY_ID;
  const apiToken = process.env.TURN_KEY_API_TOKEN;
  if (!keyId || !apiToken) {
    return res.status(404).json({ error: 'Cloudflare Realtime TURN not configured' });
  }

  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        // 1 hour is comfortably longer than any call, but short enough
        // that a leaked credential isn't useful for long.
        body: JSON.stringify({ ttl: 3600 })
      }
    );
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Cloudflare TURN request failed: ' + text.slice(0, 200) });
    }
    const data = await r.json();
    // Cloudflare returns { iceServers: [...] } — pass it straight through.
    return res.status(200).json(data.iceServers || data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
