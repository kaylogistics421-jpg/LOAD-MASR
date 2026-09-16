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

/* ---------- AUTH ---------- */
const PIONEER_CODE = 'PIONEER3';
const PIONEER_MAX_SLOTS = 3;

router.post('/api/auth/signup', ({ req, body, sendJson }) => {
  rateLimit(req, 'signup', { max: 10, windowMs: 60 * 60 * 1000 }); // 10 signups/hour/IP — generous for real use, blocks spam scripts
  const {
    role, name, email, phone, password, website, contactPerson, managerName,
    shipperTier, trn, sijill, promoCode,
    nationalId, licenseNo, fleetCount, truckCategories, operatingGovs
  } = body;
  if (!['carrier', 'shipper'].includes(role)) throw new ApiError(400, 'role must be carrier or shipper.');
  if (!name || !email || !phone || !password) throw new ApiError(400, 'name, email, phone, and password are required.');
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
      if (pioneerCount < PIONEER_MAX_SLOTS) {
        isPioneer = 1; verified = 1; plan = 'Founding Shipper (Free)'; verificationStatus = 'APPROVED';
      }
      // If the code is valid but slots are gone, the account is created
      // normally — same behavior as the frontend prototype (no error, just
      // no pioneer perk).
    }
  } else {
    // Carriers get a 30-day free Pro trial immediately, same as the prototype.
    verified = 1; verificationStatus = 'APPROVED'; plan = 'Pro (30-day free trial)';
    isFreeTrialPro = 1; trialEndsAt = now + 30 * 24 * 60 * 60 * 1000;
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
router.post('/api/auth/select-plan', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  if (!body.plan) throw new ApiError(400, 'plan is required.');
  db.prepare("UPDATE users SET plan = ?, verified = 1, verification_status = 'APPROVED' WHERE id = ?").run(body.plan, user.id);
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

/* Real, shared, atomic pioneer-slot count — not a client-guessed number. */
router.get('/api/pioneer-status', ({ sendJson }) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_pioneer_shipper = 1').get().c;
  sendJson(200, { slotsUsed: count, slotsRemaining: Math.max(0, PIONEER_MAX_SLOTS - count), maxSlots: PIONEER_MAX_SLOTS });
});

router.post('/api/auth/login', ({ req, body, sendJson }) => {
  rateLimit(req, 'login', { max: 10, windowMs: 15 * 60 * 1000 }); // 10 attempts/15min/IP — the actual brute-force guard
  const { email, password } = body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
    throw new ApiError(401, 'Incorrect email or password.');
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
router.get('/api/trucks', ({ sendJson }) => {
  const rows = db.prepare("SELECT * FROM trucks WHERE status = 'Active' ORDER BY posted_at DESC").all();
  sendJson(200, { trucks: rows });
});

router.get('/api/trucks/mine', ({ req, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const rows = db.prepare('SELECT * FROM trucks WHERE carrier_id = ? ORDER BY posted_at DESC').all(user.id);
  sendJson(200, { trucks: rows });
});

router.post('/api/trucks', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
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
router.get('/api/loads', ({ sendJson }) => {
  const rows = db.prepare("SELECT * FROM loads WHERE status = 'Active' ORDER BY posted_at DESC").all();
  sendJson(200, { loads: rows });
});

router.get('/api/loads/mine', ({ req, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const rows = db.prepare('SELECT * FROM loads WHERE shipper_id = ? ORDER BY posted_at DESC').all(user.id);
  sendJson(200, { loads: rows });
});

router.get('/api/loads/booked', ({ req, sendJson }) => {
  const user = requireAuth(req, ['carrier']);
  const rows = db.prepare("SELECT * FROM loads WHERE booked_by_carrier_id = ? AND status != 'Completed' ORDER BY posted_at DESC").all(user.id);
  sendJson(200, { loads: rows });
});

router.post('/api/loads', ({ req, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const { origin, originArea, dest, destArea, cargo, equip, weight, pickupDate, pickupType, pickupTime, paymentTerms, handling, notes, rate } = body;
  if (!origin || !dest || !cargo || !equip) throw new ApiError(400, 'origin, dest, cargo, and equip are required.');
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

function generateInvoicesForLoad(load, shipperUser) {
  if (load.invoices_generated) {
    return db.prepare('SELECT * FROM invoices WHERE load_id = ?').all(load.id);
  }
  db.prepare("UPDATE loads SET invoices_generated = 1, status = 'Completed' WHERE id = ?").run(load.id);
  if (!load.rate) return [];

  const fin = computeLoadFinancials(load);
  const issueDate = Date.now();
  const payoutDueDate = issueDate + BILLING_RATES.standardPayoutDays * 24 * 60 * 60 * 1000;
  const isContract = shipperUser.shipper_tier === 'Contract';
  const shipperDueDate = isContract ? issueDate + 7 * 24 * 60 * 60 * 1000 : issueDate;
  const carrier = load.booked_by_carrier_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(load.booked_by_carrier_id) : null;

  const rows = [
    { role: 'shipper', partyName: shipperUser.name, partyPhone: shipperUser.phone, partyEmail: shipperUser.email,
      amount: fin.shipperTotalDue, terms: isContract ? 'Net 7 Bank Transfer (post-POD)' : 'Due immediately',
      dueDate: shipperDueDate, settlementStatus: 'Pending Payment' },
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
router.get('/api/invoices/mine', ({ req, sendJson }) => {
  const user = requireAuth(req);
  let rows;
  if (user.role === 'shipper') {
    rows = db.prepare(`
      SELECT i.* FROM invoices i JOIN loads l ON i.load_id = l.id
      WHERE l.shipper_id = ? AND i.role = 'shipper' ORDER BY i.issue_date DESC
    `).all(user.id);
  } else if (user.role === 'carrier') {
    rows = db.prepare(`
      SELECT i.* FROM invoices i JOIN loads l ON i.load_id = l.id
      WHERE l.booked_by_carrier_id = ? AND i.role IN ('carrier','dispatcher') ORDER BY i.issue_date DESC
    `).all(user.id);
  } else {
    rows = db.prepare('SELECT * FROM invoices ORDER BY issue_date DESC').all();
  }
  sendJson(200, { invoices: rows });
});

router.post('/api/invoices/:id/receipt', ({ req, params, body, sendJson }) => {
  const user = requireAuth(req, ['shipper']);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(params.id);
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(invoice.load_id);
  if (!load || load.shipper_id !== user.id) throw new ApiError(403, 'Not authorized.');
  const doc = saveDocument({
    ownerUserId: user.id, loadId: load.id, kind: 'payment_receipt',
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
  db.prepare("UPDATE users SET verification_status = 'APPROVED' WHERE id = ?").run(params.id);
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(params.id)) });
});

router.post('/api/admin/users/:id/reject', ({ req, params, body, sendJson }) => {
  requireAuth(req, ['admin']);
  if (!body.reason) throw new ApiError(400, 'A rejection reason is required.');
  db.prepare("UPDATE users SET verification_status = 'REJECTED', reject_reason = ? WHERE id = ?").run(body.reason, params.id);
  sendJson(200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(params.id)) });
});

router.get('/api/admin/payment-verifications', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare("SELECT * FROM invoices WHERE role = 'shipper' AND settlement_status = 'In Verification'").all();
  sendJson(200, { invoices: rows });
});

router.post('/api/admin/invoices/:id/confirm-settled', ({ req, params, sendJson }) => {
  requireAuth(req, ['admin']);
  db.prepare("UPDATE invoices SET settlement_status = 'Settled', status = 'Paid' WHERE id = ?").run(params.id);
  sendJson(200, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(params.id) });
});

/* Full-visibility oversight — every load and every truck on the platform,
   no ownership scoping at all, mirroring the frontend prototype's admin
   panel. This is the one place that's meant to see everything. */
router.get('/api/admin/loads', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare(`
    SELECT l.*, u.name as shipper_name, u.phone as shipper_phone
    FROM loads l JOIN users u ON l.shipper_id = u.id
    ORDER BY l.posted_at DESC
  `).all();
  sendJson(200, { loads: rows });
});

router.get('/api/admin/trucks', ({ req, sendJson }) => {
  requireAuth(req, ['admin']);
  const rows = db.prepare(`
    SELECT t.*, u.name as carrier_name, u.phone as carrier_phone
    FROM trucks t JOIN users u ON t.carrier_id = u.id
    ORDER BY t.posted_at DESC
  `).all();
  sendJson(200, { trucks: rows });
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
