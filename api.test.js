/* Real end-to-end test suite — makes actual HTTP requests against a running
   instance of the server (start it first: `npm start`, then `npm test` in
   another terminal, or use test/run.sh which does both). No mocking. */

const BASE = process.env.BASE_URL || 'http://localhost:4000';
let passed = 0, failed = 0;

function check(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON response, e.g. file stream */ }
  return { status: res.status, json, res };
}

// A tiny valid 1x1 PNG, base64-encoded — used to test real file upload/storage.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function run() {
  console.log('=== AUTH ===');
  const shipperEmail = `shipper_${Date.now()}@test.com`;
  const carrierEmail = `carrier_${Date.now()}@test.com`;

  let r = await api('POST', '/api/auth/signup', { body: { role: 'shipper', name: 'Test Shipper Co', email: shipperEmail, phone: '0100000001', password: 'testpass123', shipperTier: 'Contract' } });
  check('shipper signup returns 201', r.status === 201);
  check('shipper signup returns a token', !!r.json.token);
  check('shipper starts unverified (PENDING)', r.json.user.verification_status === 'PENDING');
  const shipperToken = r.json.token;
  const shipperId = r.json.user.id;

  r = await api('POST', '/api/auth/signup', { body: { role: 'shipper', name: 'Dup', email: shipperEmail, phone: '0100000002', password: 'x' } });
  check('duplicate email signup rejected (409)', r.status === 409);

  r = await api('POST', '/api/auth/login', { body: { email: shipperEmail, password: 'wrongpassword' } });
  check('wrong password rejected (401)', r.status === 401);

  r = await api('POST', '/api/auth/login', { body: { email: shipperEmail, password: 'testpass123' } });
  check('correct login succeeds', r.status === 200 && !!r.json.token);

  r = await api('GET', '/api/auth/me', { token: shipperToken });
  check('GET /me returns correct identity', r.json.user.email === shipperEmail);

  r = await api('GET', '/api/auth/me', { token: 'not-a-real-token' });
  check('bogus token rejected (401)', r.status === 401);

  r = await api('POST', '/api/auth/signup', { body: { role: 'carrier', name: 'Test Carrier Co', email: carrierEmail, phone: '0111111111', password: 'carrierpass' } });
  const carrierToken = r.json.token;
  check('carrier signup succeeds', r.status === 201);

  console.log('\n=== PASSWORD SECURITY ===');
  const db = require('../src/db');
  const row = db.prepare('SELECT password_hash, password_salt FROM users WHERE email = ?').get(shipperEmail);
  check('password is NOT stored in plaintext', row.password_hash !== 'testpass123');
  check('password hash looks like a real hash (hex, 128 chars for scrypt-64)', /^[0-9a-f]{128}$/.test(row.password_hash));
  check('a random salt was generated', row.password_salt.length === 32);

  console.log('\n=== TRUCKS ===');
  r = await api('POST', '/api/trucks', { token: carrierToken, body: { origin: 'Cairo', dest: 'Alexandria', equip: 'Standard Flatbed', capacity: '5 tons', availDate: '2026-11-01' } });
  check('carrier can post a truck', r.status === 201);
  const truckId = r.json.truck.id;

  r = await api('POST', '/api/trucks', { token: shipperToken, body: { origin: 'Cairo', dest: 'Suez', equip: 'Lowboy / Low-bed' } });
  check('shipper cannot post a truck (403)', r.status === 403);

  r = await api('GET', '/api/trucks');
  check('public truck marketplace lists the posted truck', r.json.trucks.some(t => t.id === truckId));

  r = await api('PATCH', `/api/trucks/${truckId}`, { token: shipperToken, body: { status: 'Completed' } });
  check('non-owner cannot modify a truck (403)', r.status === 403);

  console.log('\n=== LOADS ===');
  r = await api('POST', '/api/loads', {
    token: shipperToken,
    body: { origin: 'Cairo', dest: 'Alexandria', cargo: 'Building materials', equip: 'Standard Flatbed', rate: 1000, handling: { labor: true } }
  });
  check('shipper can post a load', r.status === 201);
  const loadId = r.json.load.id;

  r = await api('GET', '/api/loads');
  check('public load marketplace lists the posted load', r.json.loads.some(l => l.id === loadId));

  r = await api('POST', `/api/loads/${loadId}/request`, { token: carrierToken });
  check('carrier can request/book the load', r.status === 200);
  check('load status becomes Pending', r.json.load.status === 'Pending');
  check('tracking auto-initializes to Booked', r.json.load.tracking_stage === 'Booked');

  r = await api('GET', '/api/loads');
  check('booked load disappears from the open marketplace', !r.json.loads.some(l => l.id === loadId));

  r = await api('GET', '/api/loads/booked', { token: carrierToken });
  check('carrier sees it in their booked-loads list', r.json.loads.some(l => l.id === loadId));

  console.log('\n=== TRACKING ===');
  r = await api('PATCH', `/api/loads/${loadId}/tracking`, { token: shipperToken, body: { stage: 'At Pickup' } });
  check('shipper cannot advance tracking on a load they do not haul (403)', r.status === 403);

  r = await api('PATCH', `/api/loads/${loadId}/tracking`, { token: carrierToken, body: { stage: 'At Pickup', driverName: 'Ahmed Test', driverPhone: '201099998888' } });
  check('assigned carrier can advance tracking', r.status === 200 && r.json.load.tracking_stage === 'At Pickup');
  check('driver info recorded', r.json.load.driver_name === 'Ahmed Test');

  await api('PATCH', `/api/loads/${loadId}/tracking`, { token: carrierToken, body: { stage: 'En Route' } });
  r = await api('PATCH', `/api/loads/${loadId}/tracking`, { token: carrierToken, body: { stage: 'Delivered' } });
  check('reached Delivered stage', r.json.load.tracking_stage === 'Delivered');

  console.log('\n=== REAL FILE UPLOAD (POD) ===');
  r = await api('POST', `/api/loads/${loadId}/pod`, {
    token: carrierToken,
    body: { filename: 'bol_signed.png', mimeType: 'image/png', base64Data: TINY_PNG_BASE64, tolls: 200 }
  });
  check('POD upload succeeds', r.status === 200);
  check('load pod_status becomes Uploaded', r.json.load.pod_status === 'Uploaded');
  check('manually reported tolls are saved on the load', r.json.load.tolls === 200);
  const podDocId = r.json.document.id;

  const fs = require('fs');
  const path = require('path');
  const storedPath = path.join(__dirname, '..', 'data', 'uploads', r.json.document.stored_filename);
  check('the actual file bytes exist on disk (not just a filename string)', fs.existsSync(storedPath));
  check('stored file size matches the real decoded image size', fs.statSync(storedPath).size === Buffer.from(TINY_PNG_BASE64, 'base64').length);

  r = await api('GET', `/api/documents/${podDocId}/file`, { token: 'not-a-real-token' });
  check('cannot fetch a document without auth (401)', r.status === 401);

  const otherShipperEmail = `other_${Date.now()}@test.com`;
  const other = await api('POST', '/api/auth/signup', { body: { role: 'shipper', name: 'Other Co', email: otherShipperEmail, phone: '0100000009', password: 'x12345678' } });
  const otherRes = await fetch(`${BASE}/api/documents/${podDocId}/file`, { headers: { Authorization: `Bearer ${other.json.token}` } });
  check('a different shipper cannot view this document (403)', otherRes.status === 403);

  const ownerRes = await fetch(`${BASE}/api/documents/${podDocId}/file`, { headers: { Authorization: `Bearer ${shipperToken}` } });
  check('the actual owning shipper CAN view the document', ownerRes.status === 200);
  const bytes = Buffer.from(await ownerRes.arrayBuffer());
  check('served file bytes match what was uploaded', bytes.equals(Buffer.from(TINY_PNG_BASE64, 'base64')));

  console.log('\n=== POD APPROVAL -> INVOICE GENERATION ===');
  r = await api('POST', `/api/loads/${loadId}/pod/approve`, { token: carrierToken });
  check('carrier cannot approve their own POD (403)', r.status === 403);

  r = await api('POST', `/api/loads/${loadId}/pod/approve`, { token: shipperToken });
  check('shipper can approve POD', r.status === 200);
  check('load status auto-completes', r.json.load.status === 'Completed');
  // Only carrier + dispatcher invoices auto-generate now — the shipper
  // side is deliberately manual (shipper selects delivered loads and
  // generates one consolidated invoice themselves; that endpoint isn't
  // built yet, so it's not exercised here — see the README's gap list).
  check('2 invoices generated automatically (carrier/dispatcher only)', r.json.invoices.length === 2);
  check('no shipper invoice was auto-generated', !r.json.invoices.some(i => i.role === 'shipper'));

  const carrierInv = r.json.invoices.find(i => i.role === 'carrier');
  // dispatchFee = 8% of 1000 = 80, platformCommission = 5% of 1000 = 50,
  // net = 1000-80-50+200(tolls reimbursed in full) = 1070
  check('carrier payout is correct (1070 EGP, tolls reimbursed in full)', carrierInv.amount === 1070);

  const dispatcherInv = r.json.invoices.find(i => i.role === 'dispatcher');
  check('dispatcher commission is correct (80 EGP, unaffected by tolls)', dispatcherInv.amount === 80);

  console.log('\n=== SETTLEMENT / ESCROW FLOW ===');
  // The settlement/receipt/admin-confirm endpoints are still fully real
  // and functional — they just aren't triggered automatically by POD
  // approval anymore. Seed a shipper invoice directly (matching the old
  // auto-generated shape) to keep exercising those endpoints for real,
  // rather than skip this coverage entirely.
  const shipperInvId = `inv_${require('crypto').randomBytes(4).toString('hex')}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO invoices (id, invoice_no, load_id, role, party_name, party_phone, party_email, amount, breakdown_json,
                           payment_terms, issue_date, due_date, status, settlement_status)
    VALUES (?, ?, ?, 'shipper', 'Test Shipper Co', '0100000000', ?, 1340, '{}', 'Net 7 Bank Transfer (post-POD)', ?, ?, 'Pending', 'Pending Payment')
  `).run(shipperInvId, `INV-TEST-${shipperInvId}`, loadId, shipperEmail, now, now + 7*24*60*60*1000);
  const shipperInv = { id: shipperInvId, amount: 1340 };

  r = await api('GET', '/api/invoices/mine', { token: shipperToken });
  check('shipper sees their invoice in billing', r.json.invoices.some(i => i.id === shipperInv.id));

  r = await api('POST', `/api/invoices/${shipperInv.id}/receipt`, {
    token: shipperToken,
    body: { filename: 'transfer_receipt.png', mimeType: 'image/png', base64Data: TINY_PNG_BASE64 }
  });
  check('shipper can upload a real payment receipt', r.status === 200);
  check('settlement status moves to In Verification (escrow hold)', r.json.invoice.settlement_status === 'In Verification');
  check('invoice is NOT marked Paid yet', r.json.invoice.status !== 'Paid');

  console.log('\n=== ADMIN ===');
  const adminId = require('crypto').randomBytes(4).toString('hex');
  const { hashPassword } = require('../src/auth');
  const { hash, salt } = hashPassword('adminpass');
  db.prepare(`INSERT INTO users (id, role, email, password_hash, password_salt, name, verification_status, verified, created_at)
              VALUES (?, 'admin', ?, ?, ?, 'Admin', 'APPROVED', 1, ?)`)
    .run(`adm_${adminId}`, `admin_${adminId}@test.com`, hash, salt, Date.now());
  const adminLogin = await api('POST', '/api/auth/login', { body: { email: `admin_${adminId}@test.com`, password: 'adminpass' } });
  const adminToken = adminLogin.json.token;

  r = await api('GET', '/api/admin/queue', { token: shipperToken });
  check('non-admin cannot access the KYC queue (403)', r.status === 403);

  r = await api('GET', '/api/admin/queue', { token: adminToken });
  check('admin can see pending accounts in the KYC queue', r.json.users.some(u => u.email === shipperEmail));

  r = await api('POST', `/api/admin/users/${shipperId}/approve`, { token: adminToken });
  check('admin can approve a pending account', r.status === 200 && r.json.user.verification_status === 'APPROVED');

  r = await api('GET', '/api/admin/payment-verifications', { token: adminToken });
  check('admin sees the invoice awaiting payment verification', r.json.invoices.some(i => i.id === shipperInv.id));

  r = await api('POST', `/api/admin/invoices/${shipperInv.id}/confirm-settled`, { token: adminToken });
  check('admin can confirm settlement', r.status === 200);
  check('invoice now shows Settled', r.json.invoice.settlement_status === 'Settled');
  check('invoice now shows Paid', r.json.invoice.status === 'Paid');

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('TEST RUNNER CRASHED:', e); process.exit(1); });
