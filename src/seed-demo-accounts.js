const db = require('./db');
const { hashPassword } = require('./auth');
const crypto = require('node:crypto');
function newId(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

function makeUser({role, email, password, name, extra={}}) {
  const { hash, salt } = hashPassword(password);
  const id = newId('usr');
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, role, email, password_hash, password_salt, name, contact_person, manager_name, phone, website,
                        shipper_tier, is_pioneer_shipper, trn, sijill, national_id, license_no, fleet_count,
                        truck_categories, operating_govs, is_free_trial_pro, trial_ends_at,
                        verification_status, verified, plan, created_at, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, role, email, hash, salt, name, extra.contactPerson||null, extra.managerName||null, extra.phone||null,
         extra.website||null, extra.shipperTier||null, extra.isPioneer?1:0, extra.trn||null, extra.sijill||null,
         extra.nationalId||null, extra.licenseNo||null, extra.fleetCount||null, null, null,
         extra.isFreeTrialPro?1:0, extra.trialEndsAt||null, extra.verificationStatus||'PENDING',
         extra.verified?1:0, extra.plan||null, now, now);
  return id;
}

/* Creates the admin account (required — the login gate needs one to exist)
   on every fresh, empty database — a real deployment needs this regardless.
   The two demo accounts (carrier@/shipper@loadmasr.eg, password demo1234)
   are only created if SEED_DEMO_ACCOUNTS=true is explicitly set — useful
   for local development and the test suite, but wrong for a real
   deployment: those credentials are published in this project's own
   README and test files, so anyone could log in as them on a live site.
   Only runs at all if the database is genuinely empty, so it's safe to
   call on every server start — an existing database with real accounts
   is never touched.

   The admin password comes from ADMIN_SEED_PASSWORD if set — set this to
   a real secret before a deployment's first boot (Railway: Variables tab,
   before the first deploy). Falling back to a known default is fine for
   local development, but a real deployment should never run with the
   published default — anyone who's read this file (or this project's
   README, or any conversation where it was mentioned) knows it. */
function seedDemoAccountsIfEmpty(){
  const existing = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (existing > 0) return { seeded: false };

  const adminPassword = process.env.ADMIN_SEED_PASSWORD || 'admin-seed-password';
  makeUser({role:'admin', email:'admin@loadmasr.eg', password:adminPassword, name:'LOAD MASR Admin',
    extra:{verified:1, verificationStatus:'APPROVED'}});

  if (process.env.SEED_DEMO_ACCOUNTS !== 'true') {
    return { seeded: true, demoAccountsCreated: false };
  }
  const carrierId = makeUser({role:'carrier', email:'carrier@loadmasr.eg', password:'demo1234', name:'Hesham Freight',
    extra:{phone:'010 2233 4455', verified:1, plan:'Pro', verificationStatus:'APPROVED', nationalId:'', licenseNo:'', fleetCount:''}});
  const shipperId = makeUser({role:'shipper', email:'shipper@loadmasr.eg', password:'demo1234', name:'Nile Building Supplies',
    extra:{phone:'011 2233 4455', website:'https://nilebuildingsupplies.example', verified:1, plan:'Business',
           verificationStatus:'APPROVED', shipperTier:'Contract'}});
  return { seeded: true, demoAccountsCreated: true, carrierId, shipperId };
}

module.exports = { seedDemoAccountsIfEmpty, makeUser };
