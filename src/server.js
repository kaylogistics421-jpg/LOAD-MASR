const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const db = require('./db');
const { seedDemoAccountsIfEmpty } = require('./seed-demo-accounts');
// A brand-new deploy (empty database) seeds itself with the admin account
// (required — the frontend's passcode gate logs into it) and the two demo
// accounts, automatically, once. An existing database with real accounts
// is never touched.
const seedResult = seedDemoAccountsIfEmpty();
if (seedResult.seeded) {
  console.log(seedResult.demoAccountsCreated
    ? 'First boot: seeded admin + demo accounts (admin@loadmasr.eg, carrier@loadmasr.eg, shipper@loadmasr.eg).'
    : 'First boot: seeded admin account only (admin@loadmasr.eg). Set SEED_DEMO_ACCOUNTS=true before first boot if you want the demo shipper/carrier accounts too.');
}
const { hashPassword, verifyPassword, createSession, getSessionUser, deleteSession } = require('./auth');
const { saveDocument, getDocument, documentFilePath } = require('./documents');
const { createRouter, ApiError } = require('./router');

const PORT = process.env.PORT || 4000;
const router = createRouter();

/* ---------- helpers ---------- */
function requireAuth(req, roles) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = getSessionUser(token);
  if (!user) throw new ApiError(401, 'Not authenticated.');
  if (roles && !roles.includes(user.role)) throw new ApiError(403, 'Not authorized for this action.');
  return user;
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, ...rest } = u;
  return rest;
}
/* Simple in-memory rate limiter — no dependency, resets on restart, which
   is an acceptable tradeoff for a single-instance deployment. Tracks
   attempts per (IP + bucket) in a sliding window; throws 429 once the
   limit is hit. Applied to login and signup specifically, since those are
   the realistic brute-force / spam targets — not every route needs this. */
const _rateLimitHits = new Map(); // key -> array of timestamps
function rateLimit(req, bucket, { max, windowMs }) {
  const ip = req.socket.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const hits = (_rateLimitHits.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    throw new ApiError(429, 'Too many attempts — please wait a bit before trying again.');
  }
  hits.push(now);
  _rateLimitHits.set(key, hits);
}
function tripNo() { return String(Math.floor(100 + Math.random() * 900)); }
function newId(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

/* ---------- SITE SETTINGS (admin-editable, DB-backed) ---------- */
const SETTING_DEFAULTS = {
  pioneer_max_slots: '17',
  carrier_requires_fee: 'false' // when 'true', new carriers no longer auto-verify with a free trial — they go through the same admin-set-fee flow as non-pioneer shippers
};
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : SETTING_DEFAULTS[key];
}
function setSetting(key, value) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), now);
}

router.get('/api/settings', ({ sendJson }) => {
  // Public — the frontend needs these before anyone's logged in (pioneer
  // slot display, etc.), so this deliberately has no auth requirement.
  const keys = Object.keys(SETTING_DEFAULTS);
  const out = {};
  keys.forEach(k => { out[k] = getSetting(k); });
  sendJson(200, { settings: out });
});

router.post('/api/admin/settings', ({ req, body, sendJson }) => {
  requireAuth(req, ['admin']);
  const { key, value } = body;
  if (!key || !(key in SETTING_DEFAULTS)) throw new ApiError(400, `Unknown setting: ${key}`);
  if (value === undefined || value === null || value === '') throw new ApiError(400, 'value is required.');
  setSetting(key, value);
  sendJson(200, { key, value: getSetting(key) });
});

/* ---------- AUTH ---------- */
const PIONEER_CODE = 'PIONEER3';
function pioneerMaxSlots() { return parseInt(getSetting('pioneer_max_slots'), 10) || 17; }

router.post('/api/auth/signup', ({ req, body, sendJson }) => {
  rateLimit(req, 'signup', { max: 10, windowMs: 60 * 60 * 1000 }); // 10 signups/hour/IP — generous for real use, blocks spam scripts
  const {
    role, name, email, phone, password, website, contactPerson, managerName,
    shipperTier, trn, sijill, promoCode,
    nationalId, licenseNo, fleetCount, truckCategories, operatingGovs
  } = body;
  if (!['carrier', 'shipper'].includes(role)) throw new ApiError(400, 'role must be carrier or shipper.');
  if (!name || !email || !phone || !password) throw new ApiError(400, 'name, email, phone, and password are required.');
  if (operatingGovs && Array.isArray(operatingGovs) && operatingGovs.length > 10) throw new ApiError(400, 'You can select up to 10 governorates.');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw new ApiError(409, 'An account with that email already exists.');

  const { hash, salt } = hashPassword(password);
  const id = newId('usr');
  const now = Date.now();

  let isPioneer = 0, verified = 0, plan = null, verificationStatus = 'PENDING';
  let isFreeTrialPro = 0, trialEndsAt = null;

  if (role === 'shipper') {
    if (promoCode && promoCode.trim().toUpperCase() === PIONEER_CODE) {
      const pioneerCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_pioneer_shipper = 1').get().c;
      if (pioneerCount < pioneerMaxSlots()) {
        // Pioneers are exempt from the access fee entirely (free lifetime
        // posting), but that's a billing exemption, not a KYC exemption —
        // they still need an admin to actually review their documents
        // before seeing the board, same as everyone else. See the
        // /approve endpoint below for where this actually gets granted.
        isPioneer = 1; plan = 'Founding Shipper (Free)';
      }
      // If the code is valid but slots are gone, the account is created
      // normally — same behavior as the frontend prototype (no error, just
      // no pioneer perk).
    }
  } else {
    if (getSetting('carrier_requires_fee') === 'true') {
      // Same gate as a non-pioneer shipper — admin sets a fee, carrier
      // pays and uploads a receipt, confirming it activates the account.
    } else {
      // Free 30-day trial once approved — but, same principle as above,
      // "free" is a billing exemption, not a KYC exemption. The trial
      // clock itself is recorded now so it's ready the moment an admin
      // approves, but verified/verificationStatus stay at their PENDING
      // defaults until that actually happens.
      plan = 'Pro (30-day free trial)';
      isFreeTrialPro = 1; trialEndsAt = now + 30 * 24 * 60 * 60 * 1000;
    }
  }

  db.prepare(`
    INSERT INTO users (id, role, email, password_hash, password_salt, name, contact_person, manager_name, phone, website,
                        shipper_tier, is_pioneer_shipper, trn, sijill,
                        national_id, license_no, fleet_count, truck_categories, operating_govs,
                        is_free_trial_pro, trial_ends_at,
                        verification_status, verified, plan, created_at, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, role, email, hash, salt, name, contactPerson || null, managerName || null, phone, website || null,
         role === 'shipper' ? (shipperTier || 'Spot') : null, isPioneer, trn || null, sijill || null,
         nationalId || null, licenseNo || null, fleetCount || null,
         truckCategories ? JSON.stringify(truckCategories) : null, operatingGovs ? JSON.stringify(operatingGovs) : null,
         isFreeTrialPro, trialEndsAt,
         verificationStatus, verified, plan, now, now);

  const token = createSession(id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  sendJson(201, { user: publicUser(user), token });
});

/* A regular (non-pioneer) shipper picks a plan after signup to activate
   their account — mirrors the frontend prototype's pricing-page step. */
/* No longer auto-verifies — a non-pioneer shipper's account only
   activates once an admin-set platform fee is actually paid and confirmed
   (see /api/admin/shippers/:id/set-fee and the invoice/receipt flow).
   This just records which plan they'd like, for the admin's reference. */
router.post('/api/auth/select-plan', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  if (!body.plan) throw new ApiError(400, 'plan is required.');
  db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(body.plan, user.id);
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

/* Real, shared, atomic pioneer-slot count — not a client-guessed number. */
router.get('/api/pioneer-status', ({ sendJson }) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_pioneer_shipper = 1').get().c;
  sendJson(200, { slotsUsed: count, slotsRemaining: Math.max(0, pioneerMaxSlots() - count), maxSlots: pioneerMaxSlots() });
});

router.post('/api/auth/login', ({ req, body, sendJson }) => {
  rateLimit(req, 'login', { max: 10, windowMs: 15 * 60 * 1000 }); // 10 attempts/15min/IP — the actual brute-force guard
  const { email, password } = body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    throw new ApiError(401, 'Incorrect email or password.');
  }
  if (user.account_status === 'SUSPENDED') {
    throw new ApiError(403, 'This account has been suspended. Contact support for help.');
  }
  const token = createSession(user.id);
  sendJson(200, { user: publicUser(user), token });
});

router.post('/api/auth/logout', ({ req, sendJson }) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) deleteSession(token);
  sendJson(200, { ok: true });
});

router.get('/api/auth/me', ({ req, sendJson }) => {
  const user = requireAuth(req);
  sendJson(200, { user: publicUser(user) });
});

/* ---------- TRUCKS ---------- */
router.get('/api/trucks', ({ req, sendJson }) => {
  const user = requireAuth(req);
  if (!user.verified) throw new ApiError(403, 'Your account needs to be verified before you can see the load board.');
  const rows = db.prepare(`
    SELECT t.*, u.name as carrier_name, u.phone as carrier_phone, u.email as carrier_email
    FROM trucks t JOIN users u ON t.carrier_id = u.id
    WHERE t.status = 'Active' ORDER BY t.posted_at DESC
  `).all();
  sendJson(200, { trucks: rows });
});

router.get('/api/trucks/mine', ({ req, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const rows = db.prepare(`
    SELECT t.*, u.name as carrier_name, u.phone as carrier_phone, u.email as carrier_email
    FROM trucks t JOIN users u ON t.carrier_id = u.id
    WHERE t.carrier_id = ? ORDER BY t.posted_at DESC
  `).all(user.id);
  sendJson(200, { trucks: rows });
});

router.post('/api/trucks', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  if (!user.verified) throw new ApiError(403, 'Your account needs to be verified before you can post.');
  const { origin, originArea, dest, destArea, equip, capacity, availDate, notes, rate, dhO, dhD } = body;
  // dest can be empty — that's a real, valid state ("Anywhere" / destination-flexible), not missing data.
  if (!origin || !equip) throw new ApiError(400, 'origin and equip are required.');
  const id = newId('t');
  db.prepare(`
    INSERT INTO trucks (id, carrier_id, origin, origin_area, dest, dest_area, equip, capacity, avail_date, notes, rate, dh_o, dh_d, status, posted_at, trip_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)
  `).run(id, user.id, origin, originArea || null, dest, destArea || null, equip, capacity || null, availDate || null,
         notes || null, rate || null, dhO || null, dhD || null, Date.now(), tripNo());
  sendJson(201, { truck: db.prepare('SELECT * FROM trucks WHERE id = ?').get(id) });
});

router.patch('/api/trucks/:id', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(params.id);
  if (!truck) throw new ApiError(404, 'Truck not found.');
  if (truck.carrier_id !== user.id) throw new ApiError(403, 'You do not own this truck.');
  const status = body.status || truck.status;
  db.prepare('UPDATE trucks SET status = ? WHERE id = ?').run(status, params.id);
  sendJson(200, { truck: db.prepare('SELECT * FROM trucks WHERE id = ?').get(params.id) });
});

router.delete('/api/trucks/:id', ({ req, params, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(params.id);
  if (!truck) throw new ApiError(404, 'Truck not found.');
  if (truck.carrier_id !== user.id) throw new ApiError(403, 'You do not own this truck.');
  db.prepare('DELETE FROM trucks WHERE id = ?').run(params.id);
  sendJson(200, { ok: true });
});

/* ---------- LOADS ---------- */
router.get('/api/loads', ({ req, sendJson }) => {
  const user = requireAuth(req);
  if (!user.verified) throw new ApiError(403, 'Your account needs to be verified before you can see the load board.');
  const rows = db.prepare(`
    SELECT l.*, u.name as shipper_name, u.phone as shipper_phone, u.email as shipper_email,
           bc.email as booked_by_carrier_email
    FROM loads l JOIN users u ON l.shipper_id = u.id
    LEFT JOIN users bc ON l.booked_by_carrier_id = bc.id
    WHERE l.status = 'Active' ORDER BY l.posted_at DESC
  `).all();
  sendJson(200, { loads: rows });
});

router.get('/api/loads/mine', ({ req, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const rows = db.prepare(`
    SELECT l.*, u.name as shipper_name, u.phone as shipper_phone, u.email as shipper_email,
           bc.email as booked_by_carrier_email
    FROM loads l JOIN users u ON l.shipper_id = u.id
    LEFT JOIN users bc ON l.booked_by_carrier_id = bc.id
    WHERE l.shipper_id = ? ORDER BY l.posted_at DESC
  `).all(user.id);
  sendJson(200, { loads: rows });
});

router.get('/api/loads/booked', ({ req, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const rows = db.prepare(`
    SELECT l.*, u.name as shipper_name, u.phone as shipper_phone, u.email as shipper_email
    FROM loads l JOIN users u ON l.shipper_id = u.id
    WHERE l.booked_by_carrier_id = ? AND l.status != 'Completed' ORDER BY l.posted_at DESC
  `).all(user.id);
  // Every row here is booked by the current user by definition (the WHERE
  // clause above) — no extra join needed, just attach it directly.
  rows.forEach(r => { r.booked_by_carrier_email = user.email; });
  sendJson(200, { loads: rows });
});

/* Completed loads a shipper can still pick for a consolidated freight
   invoice or tolls sheet — each list is independent, since a load can be
   in one freight invoice AND one tolls sheet, they're billed separately. */
router.get('/api/loads/ready-to-invoice', ({ req, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const rows = db.prepare(`
    SELECT * FROM loads
    WHERE shipper_id = ? AND status = 'Completed' AND rate IS NOT NULL AND shipper_freight_invoice_id IS NULL
    ORDER BY posted_at DESC
  `).all(user.id);
  sendJson(200, { loads: rows });
});

router.get('/api/loads/ready-for-tolls', ({ req, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const rows = db.prepare(`
    SELECT * FROM loads
    WHERE shipper_id = ? AND status = 'Completed' AND tolls > 0 AND shipper_tolls_invoice_id IS NULL
    ORDER BY posted_at DESC
  `).all(user.id);
  sendJson(200, { loads: rows });
});

/* One invoice covering linehaul + VAT for several delivered loads at
   once, picked by the shipper themselves — this is what actually bills
   the shipper (carrier/dispatcher invoices already auto-generate on POD
   approval; this side was deliberately left manual). VAT applies to the
   rate only, matching computeLoadFinancials — tolls are never included
   here, they're billed separately via the tolls-sheet endpoint below. */
router.post('/api/invoices/generate-freight', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const { loadIds } = body;
  if (!Array.isArray(loadIds) || loadIds.length === 0) throw new ApiError(400, 'Select at least one load.');
  const loads = loadIds.map(id => db.prepare('SELECT * FROM loads WHERE id = ?').get(id));
  for (const load of loads) {
    if (!load) throw new ApiError(404, 'One of the selected loads was not found.');
    if (load.shipper_id !== user.id) throw new ApiError(403, 'One of the selected loads is not yours.');
    if (load.status !== 'Completed') throw new ApiError(400, `Load ${load.trip_no} isn't completed yet.`);
    if (!load.rate) throw new ApiError(400, `Load ${load.trip_no} has no rate set.`);
    if (load.shipper_freight_invoice_id) throw new ApiError(400, `Load ${load.trip_no} is already on a freight invoice.`);
  }
  let linehaulTotal = 0, vatTotal = 0;
  const lineItems = loads.map(load => {
    const linehaul = load.rate;
    const vat = Math.round(linehaul * BILLING_RATES.vatPct);
    linehaulTotal += linehaul; vatTotal += vat;
    return { loadId: load.id, tripNo: load.trip_no, origin: load.origin, originArea: load.origin_area,
              dest: load.dest, destArea: load.dest_area, linehaul, vat };
  });
  const amount = linehaulTotal + vatTotal;
  const now = Date.now();
  const isContract = user.shipper_tier === 'Contract';
  const dueDate = isContract ? now + 7 * 24 * 60 * 60 * 1000 : now;
  const id = newId('inv');
  const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}-FR`;
  db.prepare(`
    INSERT INTO invoices (id, invoice_no, kind, target_user_id, role, party_name, party_phone, party_email, amount,
                           breakdown_json, included_load_ids_json, payment_terms, issue_date, due_date, status, settlement_status)
    VALUES (?, ?, 'shipper_freight', ?, 'shipper', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Pending Payment')
  `).run(id, invoiceNo, user.id, user.name, user.phone, user.email, amount,
         JSON.stringify({ linehaulTotal, vatTotal, lineItems }), JSON.stringify(loadIds),
         isContract ? 'Net 7 Bank Transfer (post-POD)' : 'Due immediately', now, dueDate);
  const update = db.prepare('UPDATE loads SET shipper_freight_invoice_id = ? WHERE id = ?');
  loadIds.forEach(loadId => update.run(id, loadId));
  sendJson(201, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) });
});

/* Tolls are a pass-through reimbursement, never taxed, and deliberately
   kept off the freight invoice entirely — this is their own, separate
   sheet, same "shipper picks which completed loads" pattern. */
router.post('/api/invoices/generate-tolls', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const { loadIds } = body;
  if (!Array.isArray(loadIds) || loadIds.length === 0) throw new ApiError(400, 'Select at least one load.');
  const loads = loadIds.map(id => db.prepare('SELECT * FROM loads WHERE id = ?').get(id));
  for (const load of loads) {
    if (!load) throw new ApiError(404, 'One of the selected loads was not found.');
    if (load.shipper_id !== user.id) throw new ApiError(403, 'One of the selected loads is not yours.');
    if (load.status !== 'Completed') throw new ApiError(400, `Load ${load.trip_no} isn't completed yet.`);
    if (!load.tolls) throw new ApiError(400, `Load ${load.trip_no} has no tolls to reimburse.`);
    if (load.shipper_tolls_invoice_id) throw new ApiError(400, `Load ${load.trip_no} is already on a tolls sheet.`);
  }
  let tollsTotal = 0;
  const lineItems = loads.map(load => {
    tollsTotal += load.tolls;
    return { loadId: load.id, tripNo: load.trip_no, origin: load.origin, originArea: load.origin_area,
              dest: load.dest, destArea: load.dest_area, tolls: load.tolls };
  });
  const now = Date.now();
  const id = newId('inv');
  const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}-TL`;
  db.prepare(`
    INSERT INTO invoices (id, invoice_no, kind, target_user_id, role, party_name, party_phone, party_email, amount,
                           breakdown_json, included_load_ids_json, payment_terms, issue_date, due_date, status, settlement_status)
    VALUES (?, ?, 'shipper_tolls', ?, 'shipper', ?, ?, ?, ?, ?, ?, 'Due immediately', ?, ?, 'Pending', 'Pending Payment')
  `).run(id, invoiceNo, user.id, user.name, user.phone, user.email, tollsTotal,
         JSON.stringify({ tollsTotal, lineItems }), JSON.stringify(loadIds), now, now);
  const update = db.prepare('UPDATE loads SET shipper_tolls_invoice_id = ? WHERE id = ?');
  loadIds.forEach(loadId => update.run(id, loadId));
  sendJson(201, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) });
});

router.post('/api/loads', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  if (!user.verified) throw new ApiError(403, 'Your account needs to be verified before you can post.');
  const { origin, originArea, dest, destArea, cargo, equip, weight, pickupDate, pickupType, pickupTime, handling, notes, rate } = body;
  if (!origin || !dest || !cargo || !equip) throw new ApiError(400, 'origin, dest, cargo, and equip are required.');
  // Payment terms are never taken from the client — each shipper tier has
  // exactly one fixed policy, enforced here regardless of what a request
  // claims, so this can't be bypassed by calling the API directly.
  const paymentTerms = user.shipper_tier === 'Contract' ? 'Net 7 Bank Transfer (post-POD)' : '50% Advance, 50% on Delivery';
  const id = newId('l');
  db.prepare(`
    INSERT INTO loads (id, shipper_id, origin, origin_area, dest, dest_area, cargo, equip, weight, pickup_date, pickup_type,
                        pickup_time, payment_terms, handling_json, notes, rate, status, posted_at, trip_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)
  `).run(id, user.id, origin, originArea || null, dest, destArea || null, cargo, equip, weight || null, pickupDate || null,
         pickupType || 'FCFS', pickupTime || null, paymentTerms || null, JSON.stringify(handling || {}), notes || null,
         rate || null, Date.now(), tripNo());
  sendJson(201, { load: db.prepare('SELECT * FROM loads WHERE id = ?').get(id) });
});

router.post('/api/loads/:id/request', ({ req, params, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id);
  if (!load) throw new ApiError(404, 'Load not found.');
  if (load.status !== 'Active') throw new ApiError(409, 'This load is no longer available.');
  db.prepare(`
    UPDATE loads SET status = 'Pending', tracking_stage = COALESCE(tracking_stage, 'Booked'), booked_by_carrier_id = ?
    WHERE id = ?
  `).run(user.id, params.id);
  sendJson(200, { load: db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id) });
});

router.patch('/api/loads/:id/tracking', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id);
  if (!load) throw new ApiError(404, 'Load not found.');
  if (load.booked_by_carrier_id !== user.id) throw new ApiError(403, 'You are not assigned to this load.');
  const validStages = ['Booked', 'At Pickup', 'En Route', 'Delivered'];
  if (!validStages.includes(body.stage)) throw new ApiError(400, 'Invalid tracking stage.');
  const updates = { driverName: body.driverName, driverPhone: body.driverPhone };
  db.prepare(`
    UPDATE loads SET tracking_stage = ?, driver_name = COALESCE(?, driver_name), driver_phone = COALESCE(?, driver_phone)
    WHERE id = ?
  `).run(body.stage, updates.driverName || null, updates.driverPhone || null, params.id);
  sendJson(200, { load: db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id) });
});

router.post('/api/loads/:id/exception', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id);
  if (!load || load.booked_by_carrier_id !== user.id) throw new ApiError(403, 'Not authorized.');
  db.prepare('UPDATE loads SET exception_type = ?, exception_note = ?, exception_at = ? WHERE id = ?')
    .run(body.type || null, body.note || null, body.type ? Date.now() : null, params.id);
  sendJson(200, { load: db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id) });
});

/* POD upload — carrier submits, expects base64 file data (see documents.js).
   Tolls are reported here too, manually, since they're only known once the
   trip is actually done. */
router.post('/api/loads/:id/pod', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id);
  if (!load || load.booked_by_carrier_id !== user.id) throw new ApiError(403, 'Not authorized.');
  if (load.tracking_stage !== 'Delivered') throw new ApiError(409, 'Load must be marked Delivered before POD can be uploaded.');
  const doc = saveDocument({
    ownerUserId: user.id, loadId: load.id, kind: 'pod',
    originalFilename: body.filename, mimeType: body.mimeType, base64Data: body.base64Data
  });
  const tolls = Number.isInteger(body.tolls) && body.tolls >= 0 ? body.tolls : 0;
  db.prepare("UPDATE loads SET pod_status = 'Uploaded', pod_document_id = ?, tolls = ? WHERE id = ?").run(doc.id, tolls, load.id);
  sendJson(200, { load: db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id), document: doc });
});

/* POD approval — shipper-only, and this is also where invoices are
   generated server-side, mirroring the frontend prototype's rule that
   settlement only begins once POD is approved. */
router.post('/api/loads/:id/pod/approve', ({ req, params, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id);
  if (!load || load.shipper_id !== user.id) throw new ApiError(403, 'Not authorized.');
  if (load.pod_status !== 'Uploaded') throw new ApiError(409, 'No POD is pending approval for this load.');
  db.prepare("UPDATE loads SET pod_status = 'Approved' WHERE id = ?").run(load.id);
  const invoices = generateInvoicesForLoad(load, user);
  sendJson(200, { load: db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id), invoices });
});

router.post('/api/loads/:id/pod/dispute', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id);
  if (!load || load.shipper_id !== user.id) throw new ApiError(403, 'Not authorized.');
  if (!body.reason) throw new ApiError(400, 'A dispute reason is required.');
  db.prepare("UPDATE loads SET pod_status = 'Disputed', pod_dispute_reason = ? WHERE id = ?").run(body.reason, load.id);
  sendJson(200, { load: db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id) });
});

/* ---------- FINANCIALS (mirrors the frontend prototype's BILLING_RATES) ---------- */
const BILLING_RATES = {
  platformCommissionPct: 0.05,
  dispatchCommissionPct: 0.08,
  quickPayFeePct: 0.02,
  vatPct: 0.14,
  standardPayoutDays: 30
};

function computeLoadFinancials(load) {
  const linehaul = load.rate || 0;
  // Tolls are a real, driver-reported expense recorded at POD submission —
  // reimbursed in full to the carrier and passed through to the shipper.
  // No platform service fee or handling/accessorial charge on the invoice.
  // VAT applies to the load rate only — tolls are added on after VAT,
  // not taxed, since they're a pass-through reimbursement.
  const tolls = load.tolls || 0;
  const shipperSubtotal = linehaul;
  const vat = Math.round(shipperSubtotal * BILLING_RATES.vatPct);
  const shipperTotalDue = shipperSubtotal + vat + tolls;

  const dispatchFee = Math.round(linehaul * BILLING_RATES.dispatchCommissionPct);
  const platformCommission = Math.round(linehaul * BILLING_RATES.platformCommissionPct);
  const carrierNetStandard = linehaul - dispatchFee - platformCommission + tolls;

  return { linehaul, tolls, vat, shipperSubtotal, shipperTotalDue, dispatchFee, platformCommission, carrierNetStandard };
}

/* Only carrier and dispatcher invoices auto-generate here — the shipper
   side is deliberately NOT auto-created. This matches the frontend's
   consolidated-invoicing design: a shipper picks which delivered loads to
   collect into one invoice themselves, rather than getting one invoice
   per load automatically. (That "generate consolidated invoice" endpoint
   doesn't exist yet — this just makes sure POD approval doesn't create a
   shipper invoice that would conflict with it once it does.) */
function generateInvoicesForLoad(load, shipperUser) {
  if (load.invoices_generated) {
    return db.prepare('SELECT * FROM invoices WHERE load_id = ?').all(load.id);
  }
  db.prepare("UPDATE loads SET invoices_generated = 1, status = 'Completed' WHERE id = ?").run(load.id);
  if (!load.rate) return [];

  const fin = computeLoadFinancials(load);
  const issueDate = Date.now();
  const payoutDueDate = issueDate + BILLING_RATES.standardPayoutDays * 24 * 60 * 60 * 1000;
  const carrier = load.booked_by_carrier_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(load.booked_by_carrier_id) : null;

  const rows = [
    { role: 'carrier', partyName: carrier ? carrier.name : 'Carrier', partyPhone: carrier ? carrier.phone : null,
      partyEmail: carrier ? carrier.email : null, amount: fin.carrierNetStandard, terms: 'Standard (30 days)',
      dueDate: payoutDueDate, settlementStatus: null },
    { role: 'dispatcher', partyName: carrier ? carrier.name : 'Dispatcher', partyPhone: carrier ? carrier.phone : null,
      partyEmail: carrier ? carrier.email : null, amount: fin.dispatchFee, terms: 'Standard (30 days)',
      dueDate: payoutDueDate, settlementStatus: null }
  ];

  const created = [];
  for (const row of rows) {
    const id = newId('inv');
    const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}-${row.role.slice(0, 2).toUpperCase()}`;
    db.prepare(`
      INSERT INTO invoices (id, invoice_no, load_id, role, party_name, party_phone, party_email, amount, breakdown_json,
                             payment_terms, issue_date, due_date, status, settlement_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)
    `).run(id, invoiceNo, load.id, row.role, row.partyName, row.partyPhone, row.partyEmail, row.amount,
           JSON.stringify(fin), row.terms, issueDate, row.dueDate, row.settlementStatus);
    created.push(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
  }
  return created;
}

/* ---------- INVOICES ---------- */
/* Admin sets a custom platform-access fee for a non-pioneer shipper — no
   fixed price tiers, admin decides the amount per account. Creates a real
   invoice the shipper sees and pays exactly like a shipment invoice
   (InstaPay / bank transfer, upload a receipt, admin confirms). */
router.post('/api/admin/users/:id/set-fee', ({ req, params, body, sendJson }) => {
  requireAuth(req, ['admin']);
  const { amount, note } = body;
  if (!amount || amount <= 0) throw new ApiError(400, 'A positive amount is required.');
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('shipper','carrier')").get(params.id);
  if (!target) throw new ApiError(404, 'User not found.');
  if (target.is_pioneer_shipper) throw new ApiError(400, 'This shipper is a Founding Shipper — free lifetime posting, no fee applies.');
  // One open platform-fee invoice per account at a time — reuse it rather
  // than stacking duplicates if the admin sets a new amount before the
  // old one is settled.
  const existing = db.prepare(`SELECT * FROM invoices WHERE kind = 'platform_fee' AND target_user_id = ? AND status != 'Paid'`).get(target.id);
  const now = Date.now();
  if (existing) {
    db.prepare(`UPDATE invoices SET amount = ?, breakdown_json = ?, issue_date = ?, settlement_status = 'Pending Payment' WHERE id = ?`)
      .run(amount, JSON.stringify({note: note||''}), now, existing.id);
    return sendJson(200, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(existing.id) });
  }
  const id = newId('inv');
  const invoiceNo = `INV-${Date.now().toString(36).toUpperCase()}-FEE`;
  db.prepare(`
    INSERT INTO invoices (id, invoice_no, kind, target_user_id, role, party_name, party_phone, party_email, amount,
                           breakdown_json, payment_terms, issue_date, due_date, status, settlement_status)
    VALUES (?, ?, 'platform_fee', ?, ?, ?, ?, ?, ?, ?, 'InstaPay', ?, ?, 'Pending', 'Pending Payment')
  `).run(id, invoiceNo, target.id, target.role, target.name, target.phone, target.email, amount,
         JSON.stringify({note: note||''}), now, now + 30*24*60*60*1000);
  sendJson(201, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) });
});

router.get('/api/invoices/mine', ({ req, sendJson }) => {
  const user = requireAuth(req);
  let rows;
  if (user.role === 'shipper') {
    rows = db.prepare(`
      SELECT i.* FROM invoices i JOIN loads l ON i.load_id = l.id
      WHERE l.shipper_id = ? AND i.role = 'shipper' ORDER BY i.issue_date DESC
    `).all(user.id);
    // Platform-fee and consolidated freight/tolls invoices all track their
    // owner via target_user_id (not load_id, since these either aren't
    // tied to a load at all, or cover several at once) — same column,
    // same ownership meaning, regardless of which kind of invoice it is.
    const otherInvoices = db.prepare(`SELECT * FROM invoices WHERE kind IN ('platform_fee','shipper_freight','shipper_tolls') AND target_user_id = ? ORDER BY issue_date DESC`).all(user.id);
    rows = [...otherInvoices, ...rows];
  } else if (user.role === 'carrier') {
    rows = db.prepare(`
      SELECT i.* FROM invoices i JOIN loads l ON i.load_id = l.id
      WHERE l.booked_by_carrier_id = ? AND i.role IN ('carrier','dispatcher') ORDER BY i.issue_date DESC
    `).all(user.id);
    const feeInvoices = db.prepare(`SELECT * FROM invoices WHERE kind = 'platform_fee' AND target_user_id = ? ORDER BY issue_date DESC`).all(user.id);
    rows = [...feeInvoices, ...rows];
  } else {
    rows = db.prepare('SELECT * FROM invoices ORDER BY issue_date DESC').all();
  }
  sendJson(200, { invoices: rows });
});

router.post('/api/invoices/:id/receipt', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['shipper', 'carrier']);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(params.id);
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  if (invoice.kind === 'platform_fee' || invoice.kind === 'shipper_freight' || invoice.kind === 'shipper_tolls') {
    // These three all track ownership via target_user_id directly — none
    // of them are tied to a single load_id (platform fees aren't tied to
    // a load at all; consolidated freight/tolls cover several loads via
    // included_load_ids_json instead), so there's no load to look up here.
    if (invoice.target_user_id !== user.id) throw new ApiError(403, 'Not authorized.');
  } else {
    if (user.role !== 'shipper') throw new ApiError(403, 'Not authorized.');
    const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(invoice.load_id);
    if (!load || load.shipper_id !== user.id) throw new ApiError(403, 'Not authorized.');
  }
  const doc = saveDocument({
    ownerUserId: user.id, loadId: invoice.kind === 'shipment' ? invoice.load_id : null, kind: 'payment_receipt',
    originalFilename: body.filename, mimeType: body.mimeType, base64Data: body.base64Data
  });
  db.prepare("UPDATE invoices SET settlement_status = 'In Verification', receipt_document_id = ? WHERE id = ?").run(doc.id, invoice.id);
  sendJson(200, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id), document: doc });
});

/* ---------- DOCUMENTS ---------- */
router.get('/api/documents/:id/file', ({ req, params, res }) => {
  const user = requireAuth(req);
  const doc = getDocument(params.id);
  if (!doc) throw new ApiError(404, 'Document not found.');
  // Owner, or the shipper who owns the load this document is attached to, or admin may view.
  const load = doc.load_id ? db.prepare('SELECT * FROM loads WHERE id = ?').get(doc.load_id) : null;
  const allowed = user.role === 'admin' || doc.owner_user_id === user.id || (load && load.shipper_id === user.id) || (load && load.booked_by_carrier_id === user.id);
  if (!allowed) throw new ApiError(403, 'Not authorized to view this document.');
  const filePath = documentFilePath(doc);
  if (!fs.existsSync(filePath)) throw new ApiError(410, 'File is missing from storage.');
  const fileHeaders = { 'Content-Type': doc.mime_type || 'application/octet-stream', 'Content-Disposition': `inline; filename="${doc.original_filename}"` };
  if (process.env.ALLOWED_ORIGIN) fileHeaders['Access-Control-Allow-Origin'] = process.env.ALLOWED_ORIGIN;
  res.writeHead(200, fileHeaders);
  fs.createReadStream(filePath).pipe(res);
});

/* ---------- ADMIN (KYC queue + payment verification) ---------- */
router.get('/api/admin/queue', ({ req, query, sendJson }) => {
  requireAuth(req, ['admin']);
  const status = query.status || 'PENDING';
  const rows = db.prepare('SELECT * FROM users WHERE verification_status = ? AND role != ? ORDER BY submitted_at DESC')
    .all(status, 'admin');
  sendJson(200, { users: rows.map(publicUser) });
});

router.post('/api/admin/users/:id/approve', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!target) throw new ApiError(404, 'User not found.');
  // KYC approval is what actually grants board access — but only for
  // accounts with no separate fee gate to clear first. A pioneer shipper
  // or a carrier under the free-trial policy has nothing else standing
  // between them and the board, so approving here is the whole story. A
  // non-pioneer shipper, or a carrier under the paid-access policy, still
  // needs to clear that separately (see /set-fee and /confirm-settled) —
  // approving their documents here confirms they're legitimate, but
  // doesn't by itself let them in.
  const needsFee = (target.role === 'shipper' && !target.is_pioneer_shipper)
    || (target.role === 'carrier' && getSetting('carrier_requires_fee') === 'true');
  if (needsFee) {
    db.prepare("UPDATE users SET verification_status = 'APPROVED' WHERE id = ?").run(params.id);
  } else {
    db.prepare("UPDATE users SET verification_status = 'APPROVED', verified = 1 WHERE id = ?").run(params.id);
  }
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(params.id)) });
});

router.post('/api/admin/users/:id/reject', ({ req, params, body, sendJson }) => {
  requireAuth(req, ['admin']);
  if (!body.reason) throw new ApiError(400, 'A rejection reason is required.');
  db.prepare("UPDATE users SET verification_status = 'REJECTED', reject_reason = ? WHERE id = ?").run(body.reason, params.id);
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(params.id)) });
});

/* Suspending doesn't touch any of their data — it blocks login (checked in
   getSessionUser) and cuts off any session they already have open. This is
   the safe, reversible way to shut off a bad actor without touching their
   loads, trucks, or financial history. */
router.post('/api/admin/users/:id/suspend', ({ req, params, sendJson }) => {
  const admin = requireAuth(req, ['admin']);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!target) throw new ApiError(404, 'User not found.');
  if (target.role === 'admin') throw new ApiError(400, 'Cannot suspend an admin account.');
  db.prepare("UPDATE users SET account_status = 'SUSPENDED' WHERE id = ?").run(params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(params.id); // kick any active session immediately
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(params.id)) });
});

router.post('/api/admin/users/:id/reactivate', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!target) throw new ApiError(404, 'User not found.');
  db.prepare("UPDATE users SET account_status = 'ACTIVE' WHERE id = ?").run(params.id);
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(params.id)) });
});

/* A real hard delete — only succeeds for an account with no financial
   history to protect. Any load/truck with a generated invoice is
   RESTRICTed from deletion at the database level (see schema.sql), so
   the cascade this triggers naturally fails rather than silently
   destroying billing records; the person should suspend instead. */
router.delete('/api/admin/users/:id', ({ req, params, sendJson }) => {
  const admin = requireAuth(req, ['admin']);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!target) throw new ApiError(404, 'User not found.');
  if (target.role === 'admin') throw new ApiError(400, 'Cannot delete an admin account.');
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(params.id);
  } catch (e) {
    throw new ApiError(409, 'This account has financial history (invoiced loads) and cannot be deleted — suspend it instead.');
  }
  sendJson(200, { deleted: true, id: params.id });
});

/* Full profile — every field, not the summary shape the queue/all-loads
   views use. Admin-only; this is deliberately more detailed than
   publicUser() shows elsewhere. */
router.get('/api/admin/users/:id', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!target) throw new ApiError(404, 'User not found.');
  sendJson(200, { user: publicUser(target) });
});

router.get('/api/admin/payment-verifications', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare("SELECT * FROM invoices WHERE role = 'shipper' AND settlement_status = 'In Verification'").all();
  sendJson(200, { invoices: rows });
});

/* Every invoice on the platform — shipment and platform-fee alike, any
   status — for full oversight, not just the ones currently awaiting
   verification. */
router.get('/api/admin/invoices', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare('SELECT * FROM invoices ORDER BY issue_date DESC').all();
  sendJson(200, { invoices: rows });
});

/* Manually mark an invoice paid — e.g. a carrier payout confirmed by bank
   transfer outside the receipt-upload flow. Deliberately does NOT let the
   amount be edited: invoices stay permanent, accurate records of what was
   actually agreed (see the immutability trigger in schema.sql) — this
   only changes payment status, never the figures themselves. */
router.post('/api/admin/invoices/:id/mark-paid', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(params.id);
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  db.prepare("UPDATE invoices SET status = 'Paid' WHERE id = ?").run(params.id);
  sendJson(200, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(params.id) });
});

router.post('/api/admin/invoices/:id/confirm-settled', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(params.id);
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  db.prepare("UPDATE invoices SET settlement_status = 'Settled', status = 'Paid' WHERE id = ?").run(params.id);
  // Confirming a platform-fee payment is what actually activates the
  // account — this is the real "admin approves the payment" step, not
  // just a label change.
  if (invoice.kind === 'platform_fee' && invoice.target_user_id) {
    const plan = invoice.role === 'carrier' ? 'Pro' : 'Standard';
    db.prepare("UPDATE users SET verified = 1, plan = ?, verification_status = 'APPROVED' WHERE id = ?").run(plan, invoice.target_user_id);
  }
  sendJson(200, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(params.id) });
});

/* Full-visibility oversight — every load and every truck on the platform,
   no ownership scoping at all, mirroring the frontend prototype's admin
   panel. This is the one place that's meant to see everything. */
router.get('/api/admin/loads', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare(`
    SELECT l.*, u.name as shipper_name, u.phone as shipper_phone, u.email as shipper_email,
           bc.email as booked_by_carrier_email
    FROM loads l JOIN users u ON l.shipper_id = u.id
    LEFT JOIN users bc ON l.booked_by_carrier_id = bc.id
    ORDER BY l.posted_at DESC
  `).all();
  sendJson(200, { loads: rows });
});

router.get('/api/admin/trucks', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare(`
    SELECT t.*, u.name as carrier_name, u.phone as carrier_phone, u.email as carrier_email
    FROM trucks t JOIN users u ON t.carrier_id = u.id
    ORDER BY t.posted_at DESC
  `).all();
  sendJson(200, { trucks: rows });
});

/* Removing a load/truck posting directly — e.g. spam, fraud, a duplicate.
   A load with real invoices already generated is RESTRICTed at the
   database level (schema.sql), same protection as deleting a user — the
   attempt fails safely rather than silently destroying billing records. */
router.delete('/api/admin/loads/:id', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(params.id);
  if (!load) throw new ApiError(404, 'Load not found.');
  if (load.shipper_freight_invoice_id || load.shipper_tolls_invoice_id) {
    // These two FKs use ON DELETE SET NULL (not RESTRICT), since a
    // consolidated invoice's own recorded figures stay valid even if a
    // load it covered is later removed — but removing the load anyway
    // would silently drop it out of that invoice's own record of what it
    // covered, which is worth refusing explicitly rather than allowing.
    throw new ApiError(409, 'This load is part of a consolidated invoice and cannot be removed.');
  }
  try {
    db.prepare('DELETE FROM loads WHERE id = ?').run(params.id);
  } catch (e) {
    throw new ApiError(409, 'This load has real invoices generated against it and cannot be removed.');
  }
  sendJson(200, { deleted: true, id: params.id });
});

router.delete('/api/admin/trucks/:id', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(params.id);
  if (!truck) throw new ApiError(404, 'Truck not found.');
  db.prepare('DELETE FROM trucks WHERE id = ?').run(params.id);
  sendJson(200, { deleted: true, id: params.id });
});

/* ---------- Negotiations (load offers + truck requests) ---------- */

function negotiationRow(id) {
  return db.prepare('SELECT * FROM negotiations WHERE id = ?').get(id);
}
function requireNegotiationParty(req, neg) {
  const user = requireAuth(req, ['shipper', 'carrier', 'admin']);
  if (user.role !== 'admin' && user.id !== neg.shipper_id && user.id !== neg.carrier_id) {
    throw new ApiError(403, 'Not a party to this negotiation.');
  }
  return user;
}

/* A carrier proposing a rate on a shipper's load, OR a shipper requesting
   a carrier's truck — same shape either way, just which side initiates
   differs. Reuses an existing Pending negotiation on the same target
   rather than creating a duplicate thread if one's already open. */
router.post('/api/negotiations', ({ req, body, sendJson }) => {
  const {
    targetType, targetId, price, note,
    pickupDate, pickupTimeFrom, pickupTimeTo, deliveryDateFrom, deliveryDateTo,
    deliveryTimeFrom, deliveryTimeTo, pickupGov, pickupArea, deliveryGov, deliveryArea,
    cargo, weight, dimensions
  } = body;
  if (!['load', 'truck'].includes(targetType)) throw new ApiError(400, 'targetType must be load or truck.');
  if (!targetId || !price) throw new ApiError(400, 'targetId and price are required.');

  let shipperId, carrierId;
  if (targetType === 'load') {
    const user = requireAuth(req, ['carrier']);
    if (!user.verified) throw new ApiError(403, 'Your account needs to be verified before you can make an offer.');
    const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(targetId);
    if (!load) throw new ApiError(404, 'Load not found.');
    shipperId = load.shipper_id; carrierId = user.id;
  } else {
    const user = requireAuth(req, ['shipper']);
    if (!user.verified) throw new ApiError(403, 'Your account needs to be verified before you can make an offer.');
    const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(targetId);
    if (!truck) throw new ApiError(404, 'Truck not found.');
    shipperId = user.id; carrierId = truck.carrier_id;
  }

  const existing = db.prepare(`SELECT * FROM negotiations WHERE target_type = ? AND target_id = ? AND status = 'Pending'`).get(targetType, targetId);
  const now = Date.now();
  const initiatorSide = targetType === 'load' ? 'carrier' : 'shipper';
  const firstOffer = { by: initiatorSide, price, note: note || '', at: now };

  if (existing) {
    const offers = JSON.parse(existing.offers_json);
    offers.push(firstOffer);
    db.prepare(`UPDATE negotiations SET offers_json = ?, declined_by = NULL, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(offers), now, existing.id);
    return sendJson(200, { negotiation: negotiationRow(existing.id) });
  }

  const id = newId('neg');
  db.prepare(`
    INSERT INTO negotiations (id, target_type, target_id, shipper_id, carrier_id, status, offers_json,
                               pickup_date, pickup_time_from, pickup_time_to, delivery_date_from, delivery_date_to,
                               delivery_time_from, delivery_time_to, pickup_gov, pickup_area, delivery_gov, delivery_area,
                               cargo, weight, dimensions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, targetType, targetId, shipperId, carrierId, JSON.stringify([firstOffer]),
         pickupDate||null, pickupTimeFrom||null, pickupTimeTo||null, deliveryDateFrom||null, deliveryDateTo||null,
         deliveryTimeFrom||null, deliveryTimeTo||null, pickupGov||null, pickupArea||null, deliveryGov||null, deliveryArea||null,
         cargo||null, weight||null, dimensions||null, now, now);
  sendJson(201, { negotiation: negotiationRow(id) });
});

router.get('/api/negotiations/:targetType/:targetId', ({ req, params, sendJson }) => {
  const user = requireAuth(req, ['shipper', 'carrier', 'admin']);
  const neg = db.prepare(`SELECT * FROM negotiations WHERE target_type = ? AND target_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(params.targetType, params.targetId);
  if (!neg) return sendJson(200, { negotiation: null });
  if (user.role !== 'admin' && user.id !== neg.shipper_id && user.id !== neg.carrier_id) {
    return sendJson(200, { negotiation: null }); // don't leak that a negotiation exists to a non-party
  }
  sendJson(200, { negotiation: neg });
});

router.post('/api/negotiations/:id/offers', ({ req, params, body, sendJson }) => {
  const neg = negotiationRow(params.id);
  if (!neg) throw new ApiError(404, 'Negotiation not found.');
  const user = requireNegotiationParty(req, neg);
  if (neg.status !== 'Pending') throw new ApiError(400, 'This negotiation is no longer open.');
  const { price, note } = body;
  if (!price) throw new ApiError(400, 'price is required.');
  const side = user.id === neg.shipper_id ? 'shipper' : 'carrier';
  const offers = JSON.parse(neg.offers_json);
  offers.push({ by: side, price, note: note || '', at: Date.now() });
  db.prepare(`UPDATE negotiations SET offers_json = ?, declined_by = NULL, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(offers), Date.now(), neg.id);
  sendJson(200, { negotiation: negotiationRow(neg.id) });
});

router.post('/api/negotiations/:id/decline', ({ req, params, sendJson }) => {
  const neg = negotiationRow(params.id);
  if (!neg) throw new ApiError(404, 'Negotiation not found.');
  const user = requireNegotiationParty(req, neg);
  if (neg.status !== 'Pending') throw new ApiError(400, 'This negotiation is no longer open.');
  const side = user.id === neg.shipper_id ? 'shipper' : 'carrier';
  // Declining doesn't close the thread — it just flags who declined the
  // latest offer, so the other side sees "declined, propose your own
  // price" and the negotiation stays open for a counter.
  db.prepare(`UPDATE negotiations SET declined_by = ?, updated_at = ? WHERE id = ?`).run(side, Date.now(), neg.id);
  sendJson(200, { negotiation: negotiationRow(neg.id) });
});

router.post('/api/negotiations/:id/accept', ({ req, params, sendJson }) => {
  const neg = negotiationRow(params.id);
  if (!neg) throw new ApiError(404, 'Negotiation not found.');
  const user = requireNegotiationParty(req, neg);
  if (neg.status !== 'Pending') throw new ApiError(400, 'This negotiation is no longer open.');
  const offers = JSON.parse(neg.offers_json);
  const latestPrice = offers[offers.length - 1].price;
  const now = Date.now();

  let linkedLoadId = null;
  if (neg.target_type === 'load') {
    db.prepare(`UPDATE loads SET status = 'Pending', tracking_stage = 'Booked', booked_by_carrier_id = ? WHERE id = ?`).run(neg.carrier_id, neg.target_id);
  } else {
    // Accepting a truck request creates a real, trackable load — mirrors
    // the frontend's existing "truck deal creates a booked load" behavior.
    const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(neg.target_id);
    linkedLoadId = newId('l');
    db.prepare(`
      INSERT INTO loads (id, shipper_id, origin, origin_area, dest, dest_area, cargo, equip, weight, pickup_date,
                          pickup_type, payment_terms, rate, status, tracking_stage, booked_by_carrier_id, posted_at, trip_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FCFS', 'Bank Transfer within 7 Days (post-delivery)', ?, 'Pending', 'Booked', ?, ?, ?)
    `).run(linkedLoadId, neg.shipper_id, neg.pickup_gov, neg.pickup_area, neg.delivery_gov, neg.delivery_area,
           neg.cargo || 'General cargo', truck.equip, neg.weight || truck.capacity || '', neg.pickup_date,
           latestPrice, neg.carrier_id, now, tripNo());
    db.prepare(`UPDATE trucks SET status = 'Pending' WHERE id = ?`).run(neg.target_id);
  }

  db.prepare(`UPDATE negotiations SET status = 'Accepted', declined_by = NULL, linked_load_id = ?, updated_at = ? WHERE id = ?`)
    .run(linkedLoadId, now, neg.id);
  sendJson(200, { negotiation: negotiationRow(neg.id), linkedLoadId });
});

/* All of the current user's negotiations in one call — shipper or carrier
   side — so the Chat tab can show real, fresh threads the moment it's
   opened, not just after visiting a detail panel that happened to sync
   that one specific negotiation. */
router.get('/api/negotiations/mine', ({ req, sendJson }) => {
  const user = requireAuth(req, ['shipper', 'carrier']);
  const col = user.role === 'shipper' ? 'shipper_id' : 'carrier_id';
  const rows = db.prepare(`SELECT * FROM negotiations WHERE ${col} = ? ORDER BY updated_at DESC`).all(user.id);
  sendJson(200, { negotiations: rows });
});

/* Full oversight — every negotiation on the platform, both parties named,
   for the admin to review or step into a stuck one. */
router.get('/api/admin/negotiations', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare(`
    SELECT n.*, s.name as shipper_name, s.email as shipper_email, c.name as carrier_name, c.email as carrier_email
    FROM negotiations n
    JOIN users s ON n.shipper_id = s.id
    JOIN users c ON n.carrier_id = c.id
    ORDER BY n.updated_at DESC
  `).all();
  sendJson(200, { negotiations: rows });
});

/* Force-closes a negotiation that's stuck — e.g. one side has gone quiet
   for days and the other wants to move on. Doesn't touch the load/truck's
   own status (that's a separate, deliberate admin action if needed);
   this just ends the back-and-forth itself. */
router.post('/api/admin/negotiations/:id/cancel', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  const neg = db.prepare('SELECT * FROM negotiations WHERE id = ?').get(params.id);
  if (!neg) throw new ApiError(404, 'Negotiation not found.');
  if (neg.status !== 'Pending') throw new ApiError(400, 'This negotiation is already closed.');
  db.prepare(`UPDATE negotiations SET status = 'Declined', declined_by = 'shipper', updated_at = ? WHERE id = ?`).run(Date.now(), params.id);
  sendJson(200, { negotiation: db.prepare('SELECT * FROM negotiations WHERE id = ?').get(params.id) });
});

/* ---------- DRIVERS (a carrier's own roster, not platform accounts) ---------- */
router.post('/api/drivers', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const { name, phone, ownerCompany } = body;
  if (!name) throw new ApiError(400, 'A driver name is required.');
  const id = newId('drv');
  db.prepare('INSERT INTO drivers (id, carrier_id, name, phone, owner_company, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, user.id, name, phone || null, ownerCompany || null, Date.now());
  sendJson(201, { driver: db.prepare('SELECT * FROM drivers WHERE id = ?').get(id) });
});

router.get('/api/drivers/mine', ({ req, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const rows = db.prepare('SELECT * FROM drivers WHERE carrier_id = ? ORDER BY active DESC, name ASC').all(user.id);
  sendJson(200, { drivers: rows });
});

router.patch('/api/drivers/:id', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id);
  if (!driver || driver.carrier_id !== user.id) throw new ApiError(404, 'Driver not found.');
  const name = body.name !== undefined ? body.name : driver.name;
  const phone = body.phone !== undefined ? body.phone : driver.phone;
  const ownerCompany = body.ownerCompany !== undefined ? body.ownerCompany : driver.owner_company;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : driver.active;
  db.prepare('UPDATE drivers SET name = ?, phone = ?, owner_company = ?, active = ? WHERE id = ?').run(name, phone, ownerCompany, active, params.id);
  sendJson(200, { driver: db.prepare('SELECT * FROM drivers WHERE id = ?').get(params.id) });
});

/* ---------- CARRIER SHIPMENTS (off-platform loads a carrier logs themselves) ---------- */
router.post('/api/carrier-shipments', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const { shipperName, shipperPhone, shipperEmail, origin, originArea, dest, destArea, cargo, weight,
          pickupDate, rate, driverId, advanceAmount } = body;
  if (!shipperName) throw new ApiError(400, 'A shipper/factory name is required.');
  if (!origin || !dest) throw new ApiError(400, 'Origin and destination are required.');
  if (driverId) {
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
    if (!driver || driver.carrier_id !== user.id) throw new ApiError(400, 'That driver was not found.');
  }
  const id = newId('cs');
  const now = Date.now();
  db.prepare(`
    INSERT INTO carrier_shipments (id, carrier_id, driver_id, shipper_name, shipper_phone, shipper_email,
                                    origin, origin_area, dest, dest_area, cargo, weight, pickup_date,
                                    rate, advance_amount, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Assigned', ?)
  `).run(id, user.id, driverId || null, shipperName, shipperPhone || null, shipperEmail || null,
         origin, originArea || null, dest, destArea || null, cargo || null, weight || null, pickupDate || null,
         rate || null, advanceAmount || 0, now);
  sendJson(201, { shipment: db.prepare('SELECT * FROM carrier_shipments WHERE id = ?').get(id) });
});

router.get('/api/carrier-shipments/mine', ({ req, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const rows = db.prepare(`
    SELECT cs.*, d.name as driver_name, d.phone as driver_phone
    FROM carrier_shipments cs LEFT JOIN drivers d ON cs.driver_id = d.id
    WHERE cs.carrier_id = ? ORDER BY cs.created_at DESC
  `).all(user.id);
  // The driver reconciliation math — advance handed out vs. what was
  // actually spent on tolls — computed here rather than trusted from the
  // client, same principle as every other financial figure in this app.
  rows.forEach(r => {
    r.driver_balance = r.actual_tolls !== null ? r.advance_amount - r.actual_tolls : null;
  });
  sendJson(200, { shipments: rows });
});

router.patch('/api/carrier-shipments/:id', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const shipment = db.prepare('SELECT * FROM carrier_shipments WHERE id = ?').get(params.id);
  if (!shipment || shipment.carrier_id !== user.id) throw new ApiError(404, 'Shipment not found.');
  const fields = [];
  const values = [];
  if (body.driverId !== undefined) { fields.push('driver_id = ?'); values.push(body.driverId || null); }
  if (body.status !== undefined) {
    if (!['Assigned','In Transit','Delivered','Settled'].includes(body.status)) throw new ApiError(400, 'Invalid status.');
    fields.push('status = ?'); values.push(body.status);
    if (body.status === 'Delivered' && !shipment.delivered_at) { fields.push('delivered_at = ?'); values.push(Date.now()); }
    if (body.status === 'Settled' && !shipment.settled_at) { fields.push('settled_at = ?'); values.push(Date.now()); }
  }
  if (body.actualTolls !== undefined) { fields.push('actual_tolls = ?'); values.push(body.actualTolls); }
  if (body.rate !== undefined) { fields.push('rate = ?'); values.push(body.rate); }
  if (fields.length === 0) throw new ApiError(400, 'Nothing to update.');
  values.push(params.id);
  db.prepare(`UPDATE carrier_shipments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM carrier_shipments WHERE id = ?').get(params.id);
  if (updated.actual_tolls !== null) updated.driver_balance = updated.advance_amount - updated.actual_tolls;
  sendJson(200, { shipment: updated });
});

/* ---------- health check ---------- */
router.get('/api/health', ({ sendJson }) => sendJson(200, { ok: true, time: Date.now() }));

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    const preflightHeaders = { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
    if (process.env.ALLOWED_ORIGIN) preflightHeaders['Access-Control-Allow-Origin'] = process.env.ALLOWED_ORIGIN;
    res.writeHead(204, preflightHeaders);
    return res.end();
  }
  // API routes go through the router; everything else falls through to the
  // frontend as static files, so this one server is the whole deployable
  // app — no separate frontend host or CORS setup needed in production.
  if (req.url.startsWith('/api/')) {
    return router.handle(req, res);
  }
  serveStatic(req, res);
});

const path = require('node:path');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  // Guard against path traversal outside the public directory.
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  // No caching at all for the app shell — this is a single-page app
  // whose only "static asset" IS the page itself, so a stale cached copy
  // (browser or any proxy in between) means real code changes silently
  // don't show up after a deploy, with no error to explain why.
  const noCacheHeaders = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache' };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Not a real static asset — fall back to index.html so client-side
      // navigation/anchors still land on the app itself.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html', ...noCacheHeaders });
        res.end(indexData);
      });
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...noCacheHeaders });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`LOAD MASR backend listening on http://localhost:${PORT}`);
});

module.exports = server;
