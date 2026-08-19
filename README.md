# Vanish — a chat that deletes itself after an hour

This is a standalone version. Once deployed, it runs on Vercel with zero
dependency on Claude — you just send your friend a normal URL.

It needs one free database (Upstash Redis) to sync messages between you and
your friend. Setup takes about 5 minutes, one time only.

## 1. Create a free Upstash Redis database

1. Go to https://upstash.com and sign up (free, no credit card).
2. Click "Create Database". Any name/region is fine. Pick the free tier.
3. On the database page, find "REST API" and copy two values:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   Keep this tab open, you'll paste these into Vercel next.

## 2. Deploy this folder to Vercel

Easiest way (no command line):
1. Put this whole folder into a GitHub repository (create a new repo, upload
   these files: `index.html`, `api/messages.js`, `api/signal.js`,
   `api/subscribe.js`, `sw.js`, `manifest.json`, `package.json`).
2. Go to https://vercel.com, sign up free, click "Add New… → Project".
3. Import that GitHub repo. Leave all settings as default and click Deploy.

Or, if you're comfortable with a terminal:
```
npm i -g vercel
cd vanish-chat-vercel
vercel
```

## 3. Add your database keys to Vercel

1. In your Vercel project, go to Settings → Environment Variables.
2. Add:
   - `UPSTASH_REDIS_REST_URL` = (the URL you copied from Upstash)
   - `UPSTASH_REDIS_REST_TOKEN` = (the token you copied from Upstash)
3. Go to the Deployments tab and redeploy (or just push a new commit).

## 4. Use it

Vercel gives you a URL like `https://vanish-chat-yourname.vercel.app`.
Send that exact link to your friend. Both of you open it, type the **same
room code**, pick your names, and start chatting. Every message vanishes
for both of you 60 minutes after it was sent — no Claude, no login, no
manual cleanup needed.

## 5. Install it as an app on your phone

This site is a PWA (installable web app) — once deployed, both you and your
friend can add it to your home screen and it'll open full-screen like a
real app, with its own icon.

**Android (Chrome):** open the site → tap the ⋮ menu → "Install app" (or
you may see an automatic "Add Vanish to Home screen" banner).

**iPhone (Safari):** open the site → tap the Share icon (square with an
arrow) → "Add to Home Screen" → Add.

**Desktop (Chrome/Edge):** open the site → click the install icon (⊕ or a
small monitor icon) in the address bar → Install.

## 6. (Optional) Turn on real notifications — including on iPhone

Tapping the bell 🔔 in the chat asks for notification permission, but by
default that only works while the app is actually open and running — it's
useless once the app is closed or your phone is locked.

To get real background notifications, this version adds **Web Push**. It
needs one extra one-time setup step: a VAPID keypair (this is just how Web
Push proves your server is allowed to send to a given subscriber — nothing
to sign up for, you generate it yourself).

1. On your own computer, with Node.js installed, run:
   ```
   npx web-push generate-vapid-keys
   ```
   This prints a **Public Key** and a **Private Key**.

2. Open `index.html` in this project and find this line near the top of
   the `<script>` block:
   ```js
   const VAPID_PUBLIC_KEY = 'PASTE_YOUR_VAPID_PUBLIC_KEY_HERE';
   ```
   Replace the placeholder with the **Public Key** you just generated, then
   redeploy (push the change to GitHub, or `vercel` again).

3. In Vercel → Settings → Environment Variables, add:
   - `VAPID_PUBLIC_KEY` = the same public key
   - `VAPID_PRIVATE_KEY` = the private key from step 1
   - `VAPID_SUBJECT` = `mailto:` + your email (any email, used only if a
     push service needs to contact you about your server, e.g. abuse)
   Then redeploy.

4. On each phone, **open the installed app from its home screen icon**
   (not from a Safari/Chrome tab) and tap the bell 🔔. Allow notifications
   when prompted.

**Important iPhone-specific notes:**
- Requires **iOS 16.4 or later**.
- The app must have been **added to the Home Screen** and opened **from
  that icon** — Safari tabs (even pinned ones) cannot receive background
  push on iOS.
- If it still doesn't work, check Settings → Notifications → Vanish on the
  phone and make sure notifications are allowed there too.
- Android Chrome and desktop Chrome/Edge don't have these restrictions —
  push works there even from a normal browser tab, as soon as you grant
  permission.

If you skip this whole section, the app still works fine — you just won't
get notified of new messages while the app is closed or backgrounded.

## 7. About voice/video calls when the app is closed or the phone is locked

Once push is set up (step 6), an incoming call also sends a push
notification — "X is calling you" — so the other person's phone can alert
them even if the app isn't open. Tapping that notification opens the app,
which then picks up the still-ringing call automatically.

**What this can't do:** no website — installed as a home-screen app or
not — is allowed to silently open your microphone and start a live call
while fully closed or locked, on any platform. That's a deliberate OS/
browser restriction, not a bug. So a call will always need the receiving
person to actually tap the notification (or already have the app open) and
accept within the ring window (45 seconds) to connect. For a call that
rings and connects with the screen off and the app fully closed, you'd need
a native app using Apple's PushKit/CallKit — that's a different, much
larger project than a website.
