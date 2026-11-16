# Render Par Deployment Guide (Roman Urdu)

TikTok Auto Post Bot ko render.com ke **free plan** par deploy karne ka poora tareeqa.
Code bilkul wahi hai jo abhi chal raha hai — Render par wo **direct mode** me chalega:
server ka apna **stable US IP** use hota hai, free proxies ki koi zaroorat nahi.

---

## Kya ghalat tha / kya theek hua

- **Purana masla:** bot Hong Kong wale server se free (rotating) proxies ke zariye TikTok
  ko request bhejta tha. TikTok datacenter/rotating IPs par session reject kar deta hai —
  is liye fresh cookies bhi "session invalid" ho jati thin.
- **Render par:** IP US region ka hai (TikTok supported) aur **stable** hai (har waqt wahi
  IP). Is liye chances bohat behtar hain. Lekin sach ye bhi hai ke Render ka IP bhi
  datacenter ka hai — agar TikTok ne phir bhi reject kiya to 100% pakka hal **Direct Post
  (Userscript)** card hai (wo aap ke phone ke apne IP se post karta hai).

---

## 8 Steps Deployment

### Step 1: GitHub repo banao
1. `github.com` par free account banao (ya login karo).
2. Right corner me **+ -> New repository**.
3. Naam likho (jaise `tiktok-bot`), **Private** select karo, **Create repository**.

### Step 2: Project ka code repo me dalo
Repo ke page par **"uploading an existing file"** link dikhe ga — us par click kar ke
project ke zaroori files upload kar do. Ya agar aap ke paas git hai to:

```
git init
git add .
git commit -m "tiktok bot"
git branch -M main
git remote add origin https://github.com/AAPKA-USERNAME/tiktok-bot.git
git push -u origin main
```

Zaroori files (ye sab repo me hone chahiye):
- `src/`, `public/`, `prisma/`
- `package.json`, `bun.lock`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`,
  `postcss.config.mjs`, `components.json`
- `Dockerfile`, `render.yaml`, `.dockerignore` (ye maine already bana diye hain)

Ye files repo me **mat** bhejo: `node_modules/`, `.next/`, `db/`, `server.log`, `dev.log`.

### Step 3: Render account
1. `render.com` kholo.
2. **Get Started / Sign Up** — Google ya GitHub se free sign up karo (card ki zaroorat nahi).

### Step 4: Web Service banao
1. Dashboard par **New + -> Web Service**.
2. **Build and deploy from a Git repository** chuno.
3. GitHub connect karo aur apna `tiktok-bot` repo select karo.

### Step 5: Settings (Render khud kar dega)
Repo me `render.yaml` mojood hai to Render blueprint detect kar lega aur ye settings khud
bhar dega:
- **Runtime:** Docker
- **Plan:** Free
- **Environment:** `TT_PROXY_MODE=direct`, `DATABASE_URL=file:/app/data/bot.db`,
  `CHROMIUM_PATH=/usr/bin/chromium`

Agar khud na bhare to manually yehi values dal dein. **Create Web Service** dabao.

### Step 6: Build (5-10 minute)
Docker image banega (bun install -> prisma -> next build -> chromium install). Logs
dekhte rahein. Pehli build me thoda waqt lagta hai.

### Step 7: URL mil jayega
Deploy complete hone par Render aap ko URL dega, jaise:
`https://tiktok-bot-xxxx.onrender.com`

### Step 8: Login + Post
1. Us URL ko Kiwi/browser me kholo.
2. Cookies paste kar ke **Login** karo (ab direct mode me login seedha TikTok se hoga —
   free proxy scan nahi hoga, bohat fast hoga).
3. Video + caption + hashtags -> **Post**.
4. **Pehli post Private** rakh kar test karna behtar hai (agar TikTok ne kuch verification
   manga ho to account safe rahe). Theek chalne ke baad Public post karein.

---

## Free Plan Ki Limitations (pehle se jaan lo)

| Baat | Matlab |
| --- | --- |
| 15 min idle = sleep | Server so jata hai; pehli request ~1 minute leti hai (cold start) |
| Ephemeral disk | Deploy/restart par DB reset — cookies dobara paste karni par sakti hain |
| 512 MB RAM | Chromium signing sirf publish ke waqt chalta hai; normal flow halka hai |
| 750 hours/month | Ek service ke liye kaafi (poora month) |

---

## Troubleshooting

**Login par "session invalid" aa raha hai (Render se bhi)**
- Fresh cookies dobara nikal kar try karein (login ke 1-2 minute ke andar).
- Agar bar bar aaye: TikTok ne is datacenter IP ko flag kiya hai. Is case me userscript
  wala tareeqa (Direct Post card) hi pakka hal hai — wo phone ka apna IP use karta hai.

**Build fail ho gaya**
- Render logs ka aakhri error dekhein. Zyada tar masla repo me koi file miss hona hota
  hai (Step 2 ki list check karein — khaas kar `bun.lock`, `prisma/`, `Dockerfile`).

**Cold start ka masla**
- UptimeRobot (free) jaisi service se har 5 min par apne Render URL ka ping laga dein —
  server jaagta rahega (free plan ke andar rehta hai).

**Video upload slow lag rahi hai**
- Video aap ke phone se Render (US) jati hai phir TikTok ke storage (ap-singapore) —
  ye 2 hops normal hain. Free plan me ye speed expect karein.
