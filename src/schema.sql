-- LOAD MASR — real backend schema
-- Mirrors the data model already proven out in the frontend prototype
-- (accounts, trucks, loads, invoices, tracking/POD, admin verification).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('carrier','shipper','admin')),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  website TEXT,

  -- shipper-specific
  shipper_tier TEXT CHECK(shipper_tier IN ('Contract','Spot')),
  is_pioneer_shipper INTEGER NOT NULL DEFAULT 0,
  trn TEXT,
  sijill TEXT,

  -- carrier-specific
  manager_name TEXT,
  national_id TEXT,
  license_no TEXT,
  fleet_count INTEGER,
  truck_categories TEXT, -- JSON array
  operating_govs TEXT,   -- JSON array
  is_free_trial_pro INTEGER NOT NULL DEFAULT 0,
  trial_ends_at INTEGER,

  -- KYC / verification (admin queue)
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING','APPROVED','REJECTED')),
  reject_reason TEXT,
  account_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(account_status IN ('ACTIVE','SUSPENDED')),
  verified INTEGER NOT NULL DEFAULT 0, -- has an active plan (billing gate, separate from KYC)
  plan TEXT,

  created_at INTEGER NOT NULL,
  submitted_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  load_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('kyc_doc','pod','payment_receipt','tax_card')),
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trucks (
  id TEXT PRIMARY KEY,
  carrier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  origin_area TEXT,
  dest TEXT NOT NULL,
  dest_area TEXT,
  equip TEXT NOT NULL,
  capacity TEXT,
  avail_date TEXT,
  notes TEXT,
  rate INTEGER,
  dh_o INTEGER,
  dh_d INTEGER,
  status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Pending','Completed')),
  posted_at INTEGER NOT NULL,
  trip_no TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loads (
  id TEXT PRIMARY KEY,
  shipper_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  origin_area TEXT,
  dest TEXT NOT NULL,
  dest_area TEXT,
  cargo TEXT NOT NULL,
  equip TEXT NOT NULL,
  weight TEXT,
  pickup_date TEXT,
  pickup_type TEXT,
  pickup_time TEXT,
  payment_terms TEXT,
  handling_json TEXT, -- {tarps,ropes,labor,crane}
  notes TEXT,
  rate INTEGER,
  status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Pending','Completed')),

  -- live tracking
  tracking_stage TEXT CHECK(tracking_stage IN ('Booked','At Pickup','En Route','Delivered')),
  driver_name TEXT,
  driver_phone TEXT,
  booked_by_carrier_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  exception_type TEXT,
  exception_note TEXT,
  exception_at INTEGER,

  -- proof of delivery
  pod_status TEXT CHECK(pod_status IN ('Uploaded','Approved','Disputed')),
  tolls INTEGER NOT NULL DEFAULT 0, -- manually reported by the carrier/driver at POD submission, reimbursed in full
  pod_document_id TEXT REFERENCES documents(id),
  pod_dispute_reason TEXT,

  -- shipper freight/tolls billing — set once a load is included in a
  -- consolidated invoice of that kind, so it can't be picked again
  shipper_freight_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  shipper_tolls_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,

  invoices_generated INTEGER NOT NULL DEFAULT 0,
  posted_at INTEGER NOT NULL,
  trip_no TEXT NOT NULL
);

/* A single, shared negotiation model for both directions: a carrier
   proposing a rate on a shipper's posted load (target_type='load'), or a
   shipper requesting a carrier's posted truck (target_type='truck', with
   the shipper's pickup/delivery/cargo details attached). Offers themselves
   are stored as a JSON array — a lightweight, ordered back-and-forth
   thread — rather than a separate table, since they're always read and
   written as a whole list together, matching how the frontend already
   models this. Reject doesn't delete a negotiation, it just flags who
   declined the last offer — the thread stays open for a counter. */
CREATE TABLE IF NOT EXISTS negotiations (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('load','truck')),
  target_id TEXT NOT NULL,
  shipper_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  carrier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Accepted','Declined')),
  declined_by TEXT CHECK(declined_by IN ('shipper','carrier')),
  offers_json TEXT NOT NULL DEFAULT '[]',

  -- only populated for target_type='truck' — the shipper's request details
  pickup_date TEXT, pickup_time_from TEXT, pickup_time_to TEXT,
  delivery_date_from TEXT, delivery_date_to TEXT, delivery_time_from TEXT, delivery_time_to TEXT,
  pickup_gov TEXT, pickup_area TEXT, delivery_gov TEXT, delivery_area TEXT,
  cargo TEXT, weight TEXT, dimensions TEXT,

  linked_load_id TEXT REFERENCES loads(id) ON DELETE SET NULL, -- set once a truck negotiation is accepted and creates a trackable load
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_negotiations_target ON negotiations(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_shipper ON negotiations(shipper_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_carrier ON negotiations(carrier_id);

-- Invoices cover two different things: a shipment (tied to a load) or a
-- platform access fee (tied to a user account directly, no load involved
-- — this is how a non-pioneer shipper's subscription is billed: an admin
-- sets a custom amount, the shipper pays and uploads a receipt exactly
-- like a shipment invoice, and confirming it activates their account).
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'shipment' CHECK(kind IN ('shipment','platform_fee','shipper_freight','shipper_tolls')),
  load_id TEXT REFERENCES loads(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  included_load_ids_json TEXT, -- consolidated shipper invoices (freight or tolls) cover several loads at once, not just one
  role TEXT NOT NULL CHECK(role IN ('shipper','carrier','dispatcher')),
  party_name TEXT,
  party_phone TEXT,
  party_email TEXT,
  amount INTEGER NOT NULL,
  breakdown_json TEXT NOT NULL,
  payment_terms TEXT,
  issue_date INTEGER NOT NULL,
  due_date INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Paid')),

  -- shipper-only escrow/settlement flow
  settlement_status TEXT CHECK(settlement_status IN ('Pending Payment','In Verification','Settled')),
  receipt_document_id TEXT REFERENCES documents(id),

  CHECK (
    (kind = 'shipment' AND load_id IS NOT NULL) OR
    (kind = 'platform_fee' AND target_user_id IS NOT NULL) OR
    (kind IN ('shipper_freight','shipper_tolls') AND included_load_ids_json IS NOT NULL)
  )
);

-- Invoices are the permanent financial/legal record of a transaction and
-- must never be removable — not through the API (no DELETE route exists
-- for them), and not through a direct database statement either. This
-- trigger makes that a real database-enforced guarantee rather than just
-- an absence of a delete endpoint: even a raw "DELETE FROM invoices" is
-- refused. ON DELETE RESTRICT on load_id above backs this up from the
-- other direction — a load can't be deleted out from under its invoices
-- either, once any have been generated for it.
CREATE TRIGGER IF NOT EXISTS invoices_no_delete
BEFORE DELETE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'Invoices cannot be deleted — they are retained as permanent records.');
END;

-- Site-wide, admin-editable settings (pioneer slot count, default fee
-- amounts, etc.) — a simple key/value store rather than a column per
-- setting, so the admin panel can add new ones without a schema change.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A carrier's own drivers — not platform accounts, just a roster the
-- carrier maintains for assigning shipments and tracking cash advances.
CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  carrier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  owner_company TEXT, -- which carrier company this driver actually belongs to — lets a dispatcher working with several carriers classify drivers by owner, not just their own fleet
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Shipments a carrier takes on directly from an off-platform source (a
-- factory emailing them, a phone call, an existing relationship) rather
-- than through the marketplace's shipper-post + negotiate flow. This is
-- deliberately separate from the `loads` table: loads assume two real
-- platform accounts negotiating a deal, and a lot of existing logic
-- (invoicing, negotiations, tracking) is built on that assumption. Here,
-- the "shipper" is often just a name and phone number, not an account —
-- so rather than force that mismatch into loads, this models the
-- carrier's own operation: who's shipping it, which driver is running it,
-- what cash advance they were given, and what actually got spent, so the
-- reconciliation math (and the driver settlement + shipper document that
-- follow from it) happens automatically instead of by hand in Excel.
CREATE TABLE IF NOT EXISTS carrier_shipments (
  id TEXT PRIMARY KEY,
  carrier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id TEXT REFERENCES drivers(id) ON DELETE SET NULL,

  shipper_name TEXT NOT NULL,
  shipper_phone TEXT,
  shipper_email TEXT,

  origin TEXT NOT NULL,
  origin_area TEXT,
  dest TEXT NOT NULL,
  dest_area TEXT,
  cargo TEXT,
  weight TEXT,
  pickup_date TEXT,

  rate INTEGER, -- what the shipper (factory) owes the carrier for this shipment
  advance_amount INTEGER NOT NULL DEFAULT 0, -- cash handed to the driver up front, for fuel/tolls
  actual_tolls INTEGER, -- recorded once the driver returns with the bill of lading — NULL until then

  status TEXT NOT NULL DEFAULT 'Assigned' CHECK(status IN ('Assigned','In Transit','Delivered','Settled')),
  bill_of_lading_document_id TEXT REFERENCES documents(id),

  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_carrier_shipments_carrier ON carrier_shipments(carrier_id);
CREATE INDEX IF NOT EXISTS idx_carrier_shipments_driver ON carrier_shipments(driver_id);
CREATE INDEX IF NOT EXISTS idx_drivers_carrier ON drivers(carrier_id);

CREATE INDEX IF NOT EXISTS idx_trucks_carrier ON trucks(carrier_id);
CREATE INDEX IF NOT EXISTS idx_loads_shipper ON loads(shipper_id);
CREATE INDEX IF NOT EXISTS idx_loads_booked_carrier ON loads(booked_by_carrier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_load ON invoices(load_id);
CREATE INDEX IF NOT EXISTS idx_documents_load ON documents(load_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
