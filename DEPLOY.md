# TriCoach — Deployment Guide

## Vereisten
- [Supabase](https://supabase.com) account (gratis tier volstaat)
- [Vercel](https://vercel.com) account
- Strava API app (op [strava.com/settings/api](https://www.strava.com/settings/api))

---

## Stap 1 — Supabase project aanmaken

1. Maak een nieuw project aan op supabase.com
2. Ga naar **SQL Editor** en plak de inhoud van `schema.sql`, dan klik **Run**
3. Noteer:
   - **Project URL** (bv. `https://abcxyz.supabase.co`)
   - **anon public key** (onder Settings → API)
   - **service_role key** (zelfde pagina, houd dit geheim)

---

## Stap 2 — Strava API app

1. Ga naar [strava.com/settings/api](https://www.strava.com/settings/api)
2. Maak een app aan:
   - **Authorization Callback Domain**: `jouw-app.vercel.app`
3. Noteer **Client ID** en **Client Secret**

---

## Stap 3 — index.html aanpassen

Open `index.html` en vervang bovenaan in het `<script>` blok:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
const STRAVA_CLIENT_ID = 'YOUR_STRAVA_CLIENT_ID';
```

---

## Stap 4 — Vercel deployen

```bash
npm install -g vercel
cd tricoach/
vercel
```

Stel de volgende **environment variables** in (via Vercel dashboard of CLI):

| Variable | Waarde |
|---|---|
| `STRAVA_CLIENT_ID` | Jouw Strava Client ID |
| `STRAVA_CLIENT_SECRET` | Jouw Strava Client Secret |
| `SUPABASE_URL` | `https://abcxyz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (geheim!) |
| `SITE_URL` | `https://jouw-app.vercel.app` |

---

## Stap 5 — Strava callback URL instellen

In je Strava API app, stel de **Authorization Callback Domain** in op je Vercel domein.

De callback handler draait op: `https://jouw-app.vercel.app/api/strava-callback`

---

## Bestandsstructuur

```
tricoach/
├── index.html              # Hoofd-app (SPA)
├── package.json            # npm dependencies
├── vercel.json             # Vercel routing config
├── schema.sql              # Supabase database schema
├── DEPLOY.md               # Dit bestand
└── api/
    ├── strava-callback.js  # OAuth login handler
    ├── strava-sync.js      # Activiteiten synchronisatie
    └── garmin-push.js      # Workout naar Garmin pushen
```

---

## Lokaal testen

```bash
npm install
vercel dev
```

Vercel dev draait de serverless functions lokaal. Zorg dat je `.env.local` hebt:

```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SITE_URL=http://localhost:3000
```
