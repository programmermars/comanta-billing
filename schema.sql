-- Quotations, invoices and receipts (admin at /admin, client view at /d/<token>, command line tools/billing.mjs).
-- Amounts are stored in sen (RM 1.00 = 100) so totals never have rounding errors.
-- Apply once:  npx wrangler d1 execute billing-db --remote --file=schema.sql
-- Then fill in your business details at /admin/settings (these values are placeholders).

CREATE TABLE IF NOT EXISTS billing_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO billing_settings (key, value) VALUES
  ('biz_name', 'Your Business Name'),
  ('reg_no', 'SSM 000000000000'),
  ('address', 'Street, Postcode City, State, Malaysia'),
  ('email', 'billing@example.com'),
  ('phone', '+60 12-345 6789'),
  ('whatsapp', ''),
  ('website', 'example.com'),
  ('tin', ''),
  ('logo_url', ''),
  ('number_prefix', ''),
  ('bank_name', 'Your Bank'),
  ('bank_account_name', 'Your Business Name'),
  ('bank_account_no', ''),
  ('quote_valid_days', '14'),
  ('deposit_pct', '50'),
  ('invoice_due_days', '7'),
  ('quote_terms', '1. This quotation is valid until the date shown above.
2. A deposit of {deposit}% is payable on acceptance; work starts after the deposit is received.
3. The balance is invoiced on delivery and is payable within {due} days.
4. Scope changes after acceptance are quoted separately.'),
  ('invoice_terms', '1. Please pay within {due} days of the invoice date.
2. Use the invoice number as the payment reference.
3. Please send the payment slip to {email} or WhatsApp {phone}.'),
  ('sst_note', 'Not registered for SST. No SST is charged.');

CREATE TABLE IF NOT EXISTS clients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name       TEXT NOT NULL,            -- contact person
  company    TEXT,
  email      TEXT,
  phone      TEXT,
  address    TEXT,
  reg_no     TEXT,                     -- SSM / company registration no.
  tin        TEXT                      -- client's tax number, for e-Invoice when they ask for one
);

CREATE TABLE IF NOT EXISTS docs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  kind          TEXT NOT NULL CHECK (kind IN ('quote', 'invoice')),
  number        TEXT NOT NULL UNIQUE,  -- QT-2026-001 / INV-2026-001
  token         TEXT NOT NULL UNIQUE,  -- secret part of the client link /d/<token>
  client_id     INTEGER REFERENCES clients(id),
  title         TEXT,
  issue_date    TEXT NOT NULL,         -- YYYY-MM-DD (Malaysia date)
  end_date      TEXT,                  -- quote: valid until; invoice: due date
  status        TEXT NOT NULL,         -- quote: draft|sent|accepted|declined|invoiced ; invoice: draft|sent|paid|void
  items         TEXT NOT NULL,         -- JSON [{desc, qty, price_sen}]
  discount_sen  INTEGER NOT NULL DEFAULT 0,
  total_sen     INTEGER NOT NULL,
  deposit_pct   INTEGER NOT NULL DEFAULT 0,  -- quote: deposit asked on acceptance
  invoice_type  TEXT,                  -- invoice: full|deposit|balance
  bill_sen      INTEGER,               -- invoice: amount billed on this invoice (deposit/balance part of total)
  paid_sen      INTEGER NOT NULL DEFAULT 0,
  paid_date     TEXT,
  payment_ref   TEXT,
  quote_id      INTEGER REFERENCES docs(id),  -- invoice made from this quote
  order_id      INTEGER,               -- website order this came from (orders.id)
  notes         TEXT,                  -- shown on the document
  terms         TEXT,                  -- shown on the document
  accepted_at   TEXT,
  accepted_name TEXT,
  synced_at     TEXT                   -- last PDF export (tools/billing.mjs sync)
);
CREATE INDEX IF NOT EXISTS docs_kind ON docs (kind, id);

-- Official receipts: one per payment received against an invoice (issued after the payment proof arrives).
CREATE TABLE IF NOT EXISTS receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  number      TEXT NOT NULL UNIQUE,   -- RCPT-2026-001
  token       TEXT NOT NULL UNIQUE,   -- client link /d/<token>
  invoice_id  INTEGER NOT NULL REFERENCES docs(id),
  client_id   INTEGER REFERENCES clients(id),
  amount_sen  INTEGER NOT NULL,
  paid_date   TEXT NOT NULL,          -- date the money arrived
  method      TEXT,                   -- e.g. DuitNow transfer
  ref         TEXT,                   -- bank reference
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'issued',  -- issued | void
  synced_at   TEXT
);
CREATE INDEX IF NOT EXISTS receipts_invoice ON receipts (invoice_id);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,              -- QT-2026 / INV-2026
  value INTEGER NOT NULL
);

-- Admin login by one-time code emailed to the owner (OWNER_EMAIL).
CREATE TABLE IF NOT EXISTS admin_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  code_hash  TEXT NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Every payment received on an invoice (the books count income on the date the money arrived).
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  invoice_id  INTEGER NOT NULL REFERENCES docs(id),
  amount_sen  INTEGER NOT NULL,
  paid_date   TEXT NOT NULL,
  ref         TEXT
);
CREATE INDEX IF NOT EXISTS payments_date ON payments (paid_date);

-- Business expenses for the books and Form B.
-- reimbursed: no | to_bill (a client should pay it back) | reimbursed (client paid it back: not deductible, not income)
CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  spent_date      TEXT NOT NULL,
  vendor          TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL,
  amount_sen      INTEGER NOT NULL,
  paid_from       TEXT NOT NULL DEFAULT 'business',   -- business | personal
  reimbursed      TEXT NOT NULL DEFAULT 'no',
  client_id       INTEGER REFERENCES clients(id),
  reimbursed_date TEXT,
  deductible_pct  INTEGER NOT NULL DEFAULT 100,
  file            TEXT,                               -- receipt file name or link
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS expenses_date ON expenses (spent_date);
