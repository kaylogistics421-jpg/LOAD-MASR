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

  invoices_generated INTEGER NOT NULL DEFAULT 0,
  posted_at INTEGER NOT NULL,
  trip_no TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  load_id TEXT NOT NULL REFERENCES loads(id) ON DELETE RESTRICT,
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
  receipt_document_id TEXT REFERENCES documents(id)
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

CREATE INDEX IF NOT EXISTS idx_trucks_carrier ON trucks(carrier_id);
CREATE INDEX IF NOT EXISTS idx_loads_shipper ON loads(shipper_id);
CREATE INDEX IF NOT EXISTS idx_loads_booked_carrier ON loads(booked_by_carrier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_load ON invoices(load_id);
CREATE INDEX IF NOT EXISTS idx_documents_load ON documents(load_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
