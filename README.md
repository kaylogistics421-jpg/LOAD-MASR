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
bash test/run.sh                            # 54 raw API tests (no browser)
node test/test_invoice_immutability.js      # invoice delete-protection
node test/test_backend_e2e.js               # browser test: cross-session posting + visibility
node test/test_backend_e2e2.js              # browser test: signup, pioneer slots, admin approve, restart persistence
node test/test_admin_ui_e2e.js              # browser test: real admin UI walkthrough
node test/test_carrier_wizard_backend.js    # browser test: carrier wizard -> post a truck
node test/test_negotiation_api.js           # raw API test: offers, decline-stays-open, counter, accept (both directions)
node test/test_negotiation_ui_e2e.js        # browser test: two sessions negotiating a load offer end-to-end
node test/test_truck_negotiation_ui_e2e.js  # browser test: two sessions negotiating a truck request end-to-end
node test/test_chat_sync_e2e.js             # browser test: Chat tab shows a real thread with no prior detail-panel visit
node test/test_tracking_pod_e2e.js           # browser test: full tracking + real POD file upload + approval + invoices, cross-session
node test/test_platform_fee_api.js           # raw API test: admin sets a custom fee, shipper pays, admin confirms activates the account
node test/test_platform_fee_ui_e2e.js        # browser test: the full fee flow above, through the real UI, two separate sessions
node test/test_session_persistence.js        # browser test: sessions survive a real page reload, for all three roles
node test/test_admin_control_api.js          # raw API test: settings, suspend/delete, load/truck removal, negotiations, invoices, carrier fees
node test/test_admin_control_ui_e2e.js       # browser test: the full admin-control panel above, through the real UI
node test/test_cargo_manual_e2e.js            # browser test: free-text cargo description, cross-session
node test/test_pioneer_hidden_number.js       # browser test: pioneer count hidden from shippers, still real for admin
node test/test_consolidated_invoice_api.js    # raw API test: consolidated freight invoice + independent tolls sheet
node test/test_consolidated_invoice_ui_e2e.js # browser test: the full consolidated-invoicing flow above, through the real UI
node test/test_freight_receipt_flow.js        # browser test: real receipt upload -> admin confirms -> invoice marked Paid
node test/test_carrier_shipments_api.js       # raw API test: drivers, off-platform shipments, automatic reconciliation both directions
node test/test_carrier_ops_ui_e2e.js          # browser test: the full driver + shipment + reconciliation flow above, through the real UI
node test/test_ops_documents_ui_e2e.js        # browser test: shipper document + driver settlement generation, through the real UI
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

- **Auth**: login, logout, and both onboarding wizards create and
  authenticate real, persistent accounts
- **Posting**: Post a Load and Post a Truck write to the real database,
  visible across separate sessions
- **Negotiation** (new): a carrier proposing a rate on a shipper's load, or
  a shipper requesting a carrier's truck — full back-and-forth (offer,
  decline-stays-open, counter, accept) — is now real and shared. Proven
  with two genuinely separate browser sessions actually negotiating with
  each other: propose, see the real counter-offer, accept, and confirm a
  real trackable load gets created. Both directions (load offers and truck
  requests) tested this way.
- **Chat tab** (new): shows real negotiation threads the moment it's
  opened — proactively synced from the server, not just after visiting a
  detail panel that happened to touch that one negotiation
- **Tracking + Proof of Delivery** (new): advancing a load through its
  stages (Booked → At Pickup → En Route → Delivered), reporting an
  exception, uploading a real POD file with real tolls, approving or
  disputing it — all real and shared now. Proven with two separate
  browser sessions: a carrier's real stage updates and a real uploaded
  file show up in the shipper's own session, the shipper's real approval
  shows up back in the carrier's, and the resulting carrier/dispatcher
  invoices are generated correctly from it.
- **Platform access fee for non-pioneer shippers** (new): a non-pioneer
  shipper's account no longer self-activates. An admin sets a custom
  amount (no fixed tiers — genuinely admin-determined, per shipper), the
  shipper sees that real amount and the admin's own payment instructions,
  pays via InstaPay, uploads a real receipt, and the account only becomes
  active once an admin confirms it — proven with two separate sessions,
  including the account staying unverified right up until that
  confirmation happens. Pioneers are exempt by design (free lifetime
  posting) and the backend refuses to let anyone set a fee on one.
- **Sessions now survive a page reload** (new, and a genuine bug fix): they
  didn't before — refreshing the browser silently logged everyone out,
  admin included, since the session token only ever lived in memory. Now
  persisted and re-validated against the server on load for all three
  roles (shipper, carrier, admin) — proven directly, including that
  logging out and reloading correctly stays logged out.
- **Search / My Loads / My Trucks**: read from the real database, refreshed
  at login and whenever you navigate into Search, My Loads/Trucks, Chat, or
  Tracking
- **Full admin control** (new): beyond the KYC queue, the admin panel now
  has real control over the whole platform —
  - **Site settings**, DB-backed and editable from the panel itself: the
    Founding Shipper slot count, and a toggle to require carriers to pay
    an access fee too (off by default — carriers keep the free 30-day
    trial unless you turn it on)
  - **All Users**: suspend (blocks login immediately, including kicking
    an already-open session — doesn't touch their data), reactivate,
    delete, and view a full profile for any account
  - **All Loads / All Trucks**: delete any posting directly
  - **Negotiations**: see every offer thread on the platform with both
    real parties named, and force-close a stuck one
  - **All Invoices**: see every invoice regardless of type or status, and
    manually mark one paid (the amount itself stays immutable — this only
    changes payment status, never the figures)
  - Deleting an account or a load is genuinely safe, not just permitted:
    anything with real invoiced history is refused rather than silently
    destroyed, proven directly by building a real transaction end-to-end
    and then attempting to delete the account it belonged to
- **Cargo description is now free text** (new): shippers write what
  they're shipping directly instead of picking from a fixed list —
  proven with a custom description written in one session and shown
  correctly in a completely different carrier's session
- **Consolidated shipper invoicing and the tolls sheet are now real**
  (new): a shipper picks several delivered loads and generates one
  invoice covering linehaul + 14% VAT — tolls never enter that figure.
  Tolls get their own completely separate sheet, no VAT, pure
  reimbursement — a load can be on one but not yet the other, since
  they're billed independently. Proven with the real math (two loads
  totalling 18,000 EGP → exactly 20,520 with VAT), a real receipt
  uploaded through the real UI, and admin confirming it — which is what
  actually marks it paid. Found and fixed two real bugs building this:
  navigating into the Billing tab never actually refreshed anything
  (worked once at page load, then silently went stale forever after),
  and the receipt-upload endpoint didn't know how to authorize a
  consolidated invoice at all, since it has no single load to check
  ownership against.
- **Shipper document and driver settlement printouts** (new): from the
  My Shipments tab, a carrier can now generate a real document for the
  factory (route, cargo, amount due) and a real settlement summary for
  the driver (advance given, tolls spent, exact balance) — both
  downloadable as HTML or Word, same reliable mechanism already used for
  regular invoices. Proven directly: the driver settlement correctly
  isn't available until a delivery is actually recorded, and once it is,
  the real driver name, real advance, real tolls, and the correct
  computed balance all show up in the generated document.
- **Carrier operations — drivers, cash advances, and reconciliation**
  (new, and a genuinely separate part of the app): for a carrier running
  their own drivers on shipments that come from off-platform sources (a
  factory emailing them directly, not through the marketplace's
  shipper-post-and-negotiate flow), there's now a real "My Shipments" tab
  — a driver roster, logging a shipment with a cash advance, and
  recording actual tolls once the driver's back with the bill of lading.
  The reconciliation (what the driver owes back, or what they're still
  owed) is computed automatically, both directions — proven directly,
  including the case where the driver spent more than the advance, not
  just the simpler one. This is deliberately its own model
  (`carrier_shipments`, not `loads`) rather than forced into the
  marketplace structure, since the "shipper" here is often just a name
  and phone number, not a registered account.
- **Founding Shipper spots no longer show a number to shippers** (new):
  the banner, hero stat, and pricing page now say "Limited" rather than
  a specific count — proven that the real number appears nowhere on any
  shipper-facing screen, including the promo-code acceptance step, while
  the actual logic (whether a code is still valid) and the admin's own
  settings panel (which does need the real, editable number) are
  untouched
- **Admin**: the verification queue, Approve/Reject, and "All Loads"/"All
  Trucks" oversight all read and write the real database

## What's NOT wired yet — still running on the frontend's original
## in-memory logic only

- **Tracking-exception and POD-dispute conversations** — the backend
  models a single current exception/dispute per load, not the frontend's
  fuller back-and-forth with mutual resolve
- **Notifications** — the toast/badge system itself is still local-only
  (though the negotiation and tracking *data* behind it is now real)
- **Bulk-pay** (selecting several invoices, one receipt, one admin
  confirmation for the batch)
- **CSV batch upload** for Contract-tier shippers
- **Driver portal** (public, no-login POD upload link)
- **Real KYC document upload during signup** — the wizard captures a
  filename locally but doesn't yet send the file itself to the server; the
  admin doc-review modal is honest about this ("no real document image is
  stored or available to preview")
- **No password reset flow**
- **No audit log** of admin actions (who approved/rejected what, when)
- **No automated backups** of the database — that's on you or your host

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
