# LOAD MASR Backend

A real backend for LOAD MASR — SQLite database, hashed-password session auth,
real file storage on disk — and, as of this update, the frontend is served
BY this backend and genuinely wired to it for its core flows. This is one
deployable app now: `node src/server.js` starts everything.

## Why zero dependencies

Built entirely on Node.js's own built-in modules, since this environment has
no npm registry access:

- **Database:** `node:sqlite` (Node's built-in driver — flagged
  "experimental" by Node itself, meaning its API could change in a future
  Node version, not that the data layer is unreliable)
- **Password hashing:** `node:crypto`'s `scrypt` (a real, memory-hard KDF —
  same category as bcrypt/argon2)
- **HTTP server:** `node:http` with a small router (`src/router.js`), which
  also now serves the frontend's static files
- **File storage:** plain `fs`, writing real bytes to `uploads/`

If/when you have npm access, swapping in Express or `better-sqlite3` is
optional convenience, not a required fix.

## Running it

```bash
node src/server.js    # starts on http://localhost:4000 — open that URL, this IS the app
```

The first time it runs against an empty database, it automatically creates
the admin account and the two demo accounts below — no separate seed step,
including on a fresh deploy. An existing database with real accounts is
never touched or re-seeded.

Demo accounts:
- Shipper: `shipper@loadmasr.eg` / `demo1234`
- Carrier: `carrier@loadmasr.eg` / `demo1234`
- Admin passcode (in the app's Admin tab): `loadmasr-admin`

Data lives in `data/loadmasr.db`, uploaded files in `data/uploads/`. Both
are real — delete them to reset to a genuinely clean slate (the next
startup will auto-seed again). Set the `DATA_DIR` environment variable to
point both at a different location — e.g. a persistent volume when
deploying to a real host — see "Deploying to a real domain" below.

## Deploying to a real domain

This is a real, stateful server — not a static site — so it needs to run
continuously somewhere, and that host needs **persistent disk storage**,
or every restart silently wipes your database. I checked this directly
rather than assume: **Render's free tier explicitly does not support
persistent disks** (confirmed from Render's own docs), so it will not
keep your data. Railway does support persistent volumes, but no longer
has a permanent free tier — budget roughly $5/month (Hobby plan).

Steps (all through each platform's web dashboard, no terminal required):

1. Put this code in a GitHub repository — create one at github.com and
   upload this folder's contents through GitHub's own "Add file → Upload
   files" button in the browser.
2. On Railway (railway.com), "New Project" → "Deploy from GitHub repo" →
   pick the repo. Railway auto-detects Node.js; no config file needed.
3. In the service's Settings, add a **Volume**, mount path `/data`, and
   add environment variables `DATA_DIR=/data` and `ADMIN_SEED_PASSWORD=`
   (a real secret you choose, not the published demo one) — both **before**
   the first deploy finishes, since the app seeds its admin account once,
   on that very first boot.
4. Once deployed, Railway gives you a live `*.up.railway.app` URL —
   open it and log in with the demo accounts above; the app seeds itself
   automatically on that very first boot, nothing else to run.
5. In the service's Settings → Networking → "Custom Domain", add your own
   domain. Railway shows you a CNAME record to add.
6. At wherever you registered your domain (GoDaddy, Namecheap, etc.), go
   to DNS settings and add that CNAME record. DNS changes can take a few
   minutes to a few hours to take effect.

## Security — what's genuinely in place, and what to still do yourself

I checked this codebase specifically for "is this actually secured," not just
"does it work," and fixed what I found:

- **Real admin login.** There used to be a hardcoded demo passcode
  (displayed directly on the page, and with a hardcoded backend password
  sitting in the shipped JavaScript — anyone could read it). That's gone.
  Admin access is now a real email/password login against a real account,
  exactly like shipper/carrier, enforced server-side by role — no
  credential embedded in any code you deploy.
- **Change the seeded admin password before a real deploy.** The admin
  account is seeded with a known default password on first boot. Set the
  `ADMIN_SEED_PASSWORD` environment variable to a real secret *before*
  the app's very first startup (on Railway: add it in Variables before
  the first deploy) — the seeded account will use that value instead of
  the published default. If you've already deployed with the default,
  change your database directly or wipe `data/loadmasr.db` and redeploy
  with the variable set.
- **Rate limiting on login and signup.** 10 login attempts per IP per 15
  minutes, 10 signups per IP per hour. Tested directly — confirmed it
  blocks even a *correct* password once the limit is hit, which is the
  actual brute-force protection that matters.
- **CORS is no longer wide open.** The frontend is served by this same
  server, so it never needed a wildcard `Access-Control-Allow-Origin` in
  the first place — removed by default. Set `ALLOWED_ORIGIN` only if some
  separately-hosted frontend genuinely needs to call this API.
- **HTTPS**: handled automatically by Railway (or Render) once you set up
  a custom domain — they provision and renew the certificate for you, no
  code change needed on this end.
- **Passwords**: hashed with `scrypt` (a real, memory-hard algorithm),
  never stored in plaintext — this was already true before today.
- **No demo accounts on a real deployment by default.** Earlier, the
  seeded carrier/shipper demo accounts (password `demo1234`, published in
  this README and the test files) were created automatically on every
  fresh deploy — meaning anyone could log in as them on your live site.
  They're now opt-in only: set `SEED_DEMO_ACCOUNTS=true` before first boot
  if you actually want them (useful for a staging environment, or before
  you're ready to onboard real users). Leave it unset for a real
  deployment — only the admin account gets created. The frontend also no
  longer ships with any hardcoded demo credentials in its own source —
  they used to sit in plain sight in the page's JavaScript even after the
  visible login hints were removed.

**Still genuinely not done, be aware before you consider this fully
hardened:**
- No account lockout after repeated failures beyond the IP-based rate
  limit (a determined attacker rotating IPs isn't stopped by this alone)
- No password reset flow
- No audit log of admin actions (who approved/rejected what, when)
- Basic file-type/size validation only — no deep content scanning
- No automated backups of `data/loadmasr.db` — that's on you or your host

## Running the tests

```bash
bash test/run.sh                          # 56 raw API tests (no browser)
node test/test_invoice_immutability.js    # invoice delete-protection
node test/test_backend_e2e.js             # browser test: cross-session posting + visibility
node test/test_backend_e2e2.js            # browser test: signup, pioneer slots, admin approve, restart persistence
node test/test_admin_ui_e2e.js            # browser test: real admin UI walkthrough
node test/test_carrier_wizard_backend.js  # browser test: carrier wizard -> post a truck
```

Each spawns its own server against a fresh `data/loadmasr.db` (delete it
first if you're re-running locally) — the server auto-seeds the demo
accounts on that first boot, same as any real deploy.

The four `_e2e` files spawn a real server, drive a real Chromium browser
(via Playwright) against it — including separate browser *contexts* to
prove data genuinely crosses sessions, not just within one tab — and in
`test_backend_e2e2.js`, actually kill and restart the server mid-test to
prove persistence. All pass as of this writing.

## What's genuinely wired to the frontend now

- **Auth**: login, logout, and both onboarding wizards (shipper — with
  working pioneer-code + real atomic slot counting via
  `/api/pioneer-status`, not a client-guessed number; carrier — with all
  its fleet/legal fields) create and authenticate real, persistent accounts
- **Posting**: Post a Load and Post a Truck write to the real database.
  Confirmed with two separate browser contexts: what one account posts, a
  completely different logged-in session can see
- **Search / My Loads / My Trucks**: read from the real database. Since
  there's no push/websocket layer, a session's view is refreshed from the
  server at login and again whenever you navigate into Search or
  My Loads/Trucks — not continuously live-updated in the background
- **Admin**: the passcode gate logs into a real seeded admin account
  server-side. The verification queue, Approve/Reject, and the "All
  Loads"/"All Trucks" oversight views all read and write the real database
  — proven by approving an account in the UI and independently confirming
  the change via a raw API call

## What's NOT wired yet — still running on the frontend's original
## in-memory logic only

- **Negotiation** — the full offer/counter/accept/reject-stays-open thread
  for both loads and trucks
- **Chat threads and notifications**
- **Tracking-exception and POD-dispute conversations** (the backend has a
  single-shot exception/dispute field each; the frontend's fuller
  back-and-forth with mutual resolve isn't modeled server-side)
- **Consolidated shipper invoicing and the separate tolls sheet** — the
  backend still auto-generates one invoice per load the old way; it hasn't
  been updated to match the frontend's "select multiple loads, generate one
  invoice" redesign, or the tolls-on-their-own-sheet model
- **Bulk-pay** (selecting several invoices, one receipt, one admin
  confirmation for the batch)
- **CSV batch upload** for Contract-tier shippers
- **Driver portal** (public, no-login POD upload link)
- **Real KYC document upload during signup** — the wizard captures a
  filename locally but doesn't yet send the file itself to the server; the
  admin doc-review modal is honest about this ("no real document image is
  stored or available to preview")
- **No password reset flow**
- **No rate limiting, no HTTPS termination, no production hardening** — put
  this behind a reverse proxy (nginx/Caddy) with TLS before exposing it
  publicly
- **CORS is wide open** (`Access-Control-Allow-Origin: *`) for local dev
  convenience — tighten this before a real public launch

## Project structure

```
public/
  index.html    — the full frontend, served as static content by this server
src/
  schema.sql    — full DB schema (users, sessions, documents, trucks, loads, invoices)
  db.js         — opens the SQLite file, applies schema on startup
  auth.js       — password hashing + session tokens
  documents.js  — real file storage (save/retrieve)
  router.js     — minimal dependency-free HTTP router
  server.js     — all routes wired together, plus static file serving and auto-seed on first boot
  seed-demo-accounts.js — the admin + demo account creation logic (called by server.js and seed.js)
seed.js         — thin CLI wrapper around seed-demo-accounts.js, for manually re-seeding a local DB
test/
  api.test.js, run.sh                — 56 raw API tests
  test_invoice_immutability.js       — invoice delete-protection
  test_backend_e2e*.js, test_admin_ui_e2e.js, test_carrier_wizard_backend.js
                                      — real-browser, cross-session, restart-persistence tests
```
