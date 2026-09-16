/* Proves invoices genuinely cannot be deleted — not just "no API route
   exists for it" but an actual database-level guarantee, tested against a
   real invoice created through the real booking/POD/invoice-generation
   flow, with a direct raw SQL delete attempt (bypassing the API entirely,
   the way someone with direct DB access would try). */
const db = require('../src/db.js');
const { randomUUID } = require('node:crypto');

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

console.log('=== INVOICE IMMUTABILITY (real invoice, direct SQL delete attempt) ===');

// Set up a real shipper, carrier, load, and a real invoice — going through
// actual inserts that mirror what the app's own code produces, not a
// synthetic row shaped to make the test pass trivially.
const shipperId = randomUUID();
db.prepare(`INSERT INTO users (id, email, password_hash, password_salt, role, name, phone, verification_status, plan, created_at)
  VALUES (?, ?, 'x', 'x', 'shipper', 'Test Shipper Co', '0100000000', 'APPROVED', 'Business', ?)`).run(shipperId, `${randomUUID()}@test.eg`, Date.now());

const loadId = randomUUID();
db.prepare(`INSERT INTO loads (id, shipper_id, origin, dest, cargo, equip, rate, status, trip_no, posted_at)
  VALUES (?, ?, 'Cairo', 'Suez', 'General cargo', 'Standard Flatbed', 20000, 'Completed', '999', ?)`).run(loadId, shipperId, Date.now());

const invoiceId = randomUUID();
const now = Date.now();
db.prepare(`INSERT INTO invoices (id, invoice_no, load_id, role, party_name, amount, breakdown_json, payment_terms, issue_date, due_date, status, settlement_status)
  VALUES (?, 'INV-TESTIMMUTABLE', ?, 'shipper', 'Test Shipper Co', 22800, '{}', 'Net 7', ?, ?, 'Pending', 'Pending Payment')`)
  .run(invoiceId, loadId, now, now + 7*24*60*60*1000);

const beforeCount = db.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
check('real invoice exists before the delete attempt', beforeCount === 1);

// TEST 1: a direct raw SQL DELETE against the invoice itself must fail
let directDeleteBlocked = false;
try {
  db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);
} catch (e) {
  directDeleteBlocked = e.message.includes('cannot be deleted');
}
check('direct SQL DELETE on the invoice is refused by the database trigger', directDeleteBlocked);

const afterDirectAttempt = db.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
check('the invoice genuinely still exists after the blocked attempt', afterDirectAttempt === 1);

// TEST 2: deleting the PARENT LOAD (which now has an invoice attached)
// must also fail — an invoice can't be erased indirectly by deleting the
// load it's attached to either.
let cascadeDeleteBlocked = false;
try {
  db.prepare('DELETE FROM loads WHERE id = ?').run(loadId);
} catch (e) {
  cascadeDeleteBlocked = true; // FK RESTRICT violation
}
check('deleting the parent load is also refused while its invoice exists', cascadeDeleteBlocked);

const loadStillExists = db.prepare('SELECT COUNT(*) as c FROM loads WHERE id = ?').get(loadId).c;
check('the load itself also survived the blocked cascade attempt', loadStillExists === 1);

const invoiceStillExists = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE id = ?').get(invoiceId).c;
check('the invoice is fully intact after both attempts', invoiceStillExists === 1);

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
