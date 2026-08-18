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
   these files: `index.html`, `api/messages.js`, `package.json`).
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
"# Live-Chat" 
