# TikTok Auto Post Bot

Next.js web app jo TikTok par videos automatic post karta hai — cookies paste karo, video upload karo, bot publish kar deta hai (caption + hashtags + visibility ke sath).

## Features

- **Cookie login**: apni TikTok cookies (sessionid + tt-target-idc) paste kar ke session banao
- **Video upload queue**: live progress (validating → uploading → finishing → publishing → done)
- **Caption + hashtags** aur public/private visibility
- **Proxy modes**:
  - `pool` — free public proxy pool with live health checks
  - `direct` — server ka apna stable IP (Render deployment ke liye recommended)
- **Direct Post userscript**: `public/tiktok-auto-post.user.js` — phone se seedha TikTok Studio me post (bina cookies, bina proxy)
- **Render-ready**: `Dockerfile` + `render.yaml` blueprint (Docker runtime, free plan, direct mode)

## Render par deploy (free plan)

Repo me `render.yaml` blueprint mojood hai, is liye:

1. Render dashboard → **New + → Blueprint** → ye repo select karo
2. Render khud `render.yaml` parh lega: Docker runtime, free plan, `TT_PROXY_MODE=direct`, health check `/`
3. Deploy ke baad jo URL mile, usay kholo → fresh cookies paste karo → video upload karo

Tafseel: [Render-Deploy-Guide.md](./Render-Deploy-Guide.md)

## Local development

```bash
bun install
DATABASE_URL=file:./db/custom.db bunx prisma db push
bun run build
DATABASE_URL=file:./db/custom.db PORT=3000 node .next/standalone/server.js
```

## Important notes

- TikTok cookies sirf app ki SQLite DB me store hoti hain — `db/` folder gitignore me hai, apni real cookies kabhi commit na karo
- Render free plan: instance inactive hone par sleep ho jata hai (cold start ~1 min) aur disk ephemeral hai (redeploy par cookies/jobs reset)
- Login wali cookies ap hi ke account ki hoti hain; app sirf tumhare apne account par post karta hai
