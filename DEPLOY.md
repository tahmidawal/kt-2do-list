# Putting it on ourdate.today

About 20 minutes. Vercel throws away the filesystem between requests, so the list
lives in a hosted database and the photo in Vercel's file storage. The code
switches over on its own once the environment variables are set — locally it
still uses the SQLite file and `static/uploads/`.

## 1. Push it to GitHub

```bash
cd ~/kt-2do-list
git init && git add -A && git commit -m "K & T 2do list"
gh repo create kt-2do-list --private --source=. --push
```

`.env` is gitignored, so your keys stay on your machine.

## 2. Import it into Vercel

At vercel.com → **Add New → Project** → pick the repo → **Deploy**.
It will fail or come up empty on the first go — that's expected, it has no
database yet.

## 3. Add a database

Project → **Storage** → **Create Database** → **Neon** (Postgres). Vercel sets
`DATABASE_URL` for you. The app creates its own tables on first request.

## 4. Add photo storage

Project → **Storage** → **Create** → **Blob**. That sets `BLOB_READ_WRITE_TOKEN`.

Without this the photo upload still *appears* to work but the picture vanishes on
the next deploy, so don't skip it.

## 5. Set the rest of the environment variables

Project → **Settings** → **Environment Variables**:

| Name | Value |
|---|---|
| `OPENROUTER_API_KEY` | your OpenRouter key |
| `APP_PASSWORD` | the one password you two share |
| `SECRET_KEY` | any long random string — `openssl rand -hex 32` |

`APP_PASSWORD` is what stands between your list and the open internet. If it's
blank, the app runs with no lock screen at all.

## 6. Point the domain at it

Buy `ourdate.today`, then Project → **Settings** → **Domains** → add it and follow
the DNS instructions. HTTPS is automatic.

## 7. Redeploy and check

Deployments → **Redeploy** so it picks up the new variables. Then open the site:
you should get the lock screen, and your password should let you in.

---

## Costs

| | |
|---|---|
| Domain | ~$20–30/yr for `.today` |
| Vercel Pro | already paying for it |
| Neon Postgres | free tier is plenty for two people |
| Vercel Blob | free tier covers one photo |
| OpenRouter | ~$0.002 per "pick something for us" |

## On a Pro account

- **Leave Fluid Compute on** (Settings → Functions). It keeps instances warm, so
  the app doesn't take a few seconds to wake after a quiet spell.
- `vercel.json` allows the function 60 seconds. "Pick something for us" does a
  geocode, two route lookups, a forecast, and an AI call in sequence, which can
  take 20–30s on a bad day. Hobby's ceiling would have been tight.
- **Don't turn on Vercel's own Password Protection.** It would sit in front of the
  app's lock screen, so you'd both type two passwords. The built-in one is enough.

## If something breaks

**Everything 500s** — `DATABASE_URL` is missing or wrong. Check Storage is
connected to *this* project, then redeploy.

**Lock screen won't accept the password** — `APP_PASSWORD` has a stray space, or
you changed it without redeploying.

**Signed out constantly** — `SECRET_KEY` isn't set, so it falls back to the
password; changing the password invalidates every session.

**Photo disappears after a deploy** — `BLOB_READ_WRITE_TOKEN` isn't set, so it
saved to the throwaway filesystem.

**"Couldn't read that idea"** — `OPENROUTER_API_KEY` is missing, or the $5 ran out.
Check at openrouter.ai/activity.
