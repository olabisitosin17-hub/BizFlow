-- Bizflow schema — PostgreSQL (Railway)
-- Multi-tenant: every row belongs to a business (by code) and an app (sales/services).

-- ---------------------------------------------------------------
-- Accounts (one per registered customer). The business code is no longer
-- a login credential; it is resolved server-side from the account.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  business_name TEXT        NOT NULL,
  business_code TEXT,
  app_version   TEXT        NOT NULL,                -- SALES | SVC | BOTH
  status        TEXT        NOT NULL DEFAULT 'PENDING', -- PENDING | ACTIVE
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  verified_at   TIMESTAMPTZ,
  CHECK (app_version IN ('SALES', 'SVC', 'BOTH')),
  CHECK (status IN ('PENDING', 'ACTIVE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_email ON accounts (lower(email));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS business_code TEXT;

-- ---------------------------------------------------------------
-- Email verification tokens (hashed, single-use, expiring).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  TEXT   NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verif ON email_verifications (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_token ON email_verifications (token_hash);

-- ---------------------------------------------------------------
-- Password recovery OTP (six numeric digits, hashed).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_otp (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  otp_hash    TEXT   NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_otp ON password_otp (account_id);

-- ---------------------------------------------------------------
-- Sessions (hashed bearer tokens; replaced using raw code).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  TEXT   NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_token ON sessions (token_hash);

-- ---------------------------------------------------------------
-- Registry: one row per business-app combination.
-- Replaces the "Businesses" registry sheet.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  app           TEXT        NOT NULL DEFAULT 'SALES',  -- SALES | SERVICES
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  account_id    TEXT,                                  -- matches accounts.business_code
  CHECK (app IN ('SALES', 'SERVICES')),
  UNIQUE (code, app)
);

-- Move legacy numeric account references to the account's business code.
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_account_id_fkey;
ALTER TABLE businesses ALTER COLUMN account_id TYPE TEXT USING account_id::text;
UPDATE accounts a
SET business_code = linked.code
FROM (
  SELECT account_id, MIN(code) AS code
  FROM businesses
  WHERE account_id IS NOT NULL AND account_id ~ '^[0-9]+$'
  GROUP BY account_id
  HAVING COUNT(DISTINCT code) = 1
) linked
WHERE a.id::text = linked.account_id AND a.business_code IS NULL;
UPDATE businesses b
SET account_id = a.business_code
FROM accounts a
WHERE b.account_id = a.id::text AND a.business_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_business_code ON accounts (business_code);

CREATE INDEX IF NOT EXISTS idx_businesses_code ON businesses (code);
CREATE INDEX IF NOT EXISTS idx_businesses_active ON businesses (active);
CREATE INDEX IF NOT EXISTS idx_businesses_account_id ON businesses (account_id);

-- ---------------------------------------------------------------
-- SALES app tables
-- Each table rows are scoped to a single business by business_id.
-- ID "counters" become real sequences, so IDs are unique and race-free.
-- ---------------------------------------------------------------

-- Config / settings (Key -> Value). Counters are replaced by Postgres sequences,
-- but we keep the Config table to store display settings identically to before.
CREATE TABLE IF NOT EXISTS sales_config (
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT   NOT NULL,
  value       TEXT   NOT NULL DEFAULT '',
  PRIMARY KEY (business_id, key)
);

-- Products
CREATE TABLE IF NOT EXISTS sales_products (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id    TEXT   NOT NULL,          -- prd0001, prd0002 ...
  name          TEXT   NOT NULL,
  category      TEXT   NOT NULL DEFAULT '',
  cost_price    NUMERIC(14,2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  stock         INTEGER NOT NULL DEFAULT 0,
  unit          TEXT   NOT NULL DEFAULT 'pcs',
  UNIQUE (business_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_products_biz ON sales_products (business_id);
CREATE INDEX IF NOT EXISTS idx_sales_products_name ON sales_products (lower(name));

-- Customers
CREATE TABLE IF NOT EXISTS sales_customers (
  id              BIGSERIAL PRIMARY KEY,
  business_id     BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     TEXT   NOT NULL,        -- cus0001 ...
  name            TEXT   NOT NULL,
  phone           TEXT   NOT NULL DEFAULT '', -- kept as TEXT to preserve leading zeros
  email           TEXT   NOT NULL DEFAULT '',
  address         TEXT   NOT NULL DEFAULT '',
  total_purchases NUMERIC(14,2) NOT NULL DEFAULT 0,
  date_added      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_customers_biz ON sales_customers (business_id);
CREATE INDEX IF NOT EXISTS idx_sales_customers_phone ON sales_customers (business_id, phone);

-- Sales (header row)
CREATE TABLE IF NOT EXISTS sales_sales (
  id             BIGSERIAL PRIMARY KEY,
  business_id    BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sale_id        TEXT   NOT NULL,         -- sal0001 ...
  date           TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id    TEXT   NOT NULL DEFAULT '',
  customer_name  TEXT   NOT NULL DEFAULT 'Walk-in',
  subtotal       NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount       NUMERIC(14,2) NOT NULL DEFAULT 0, -- percentage given (e.g. 10 for 10%)
  total          NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method TEXT   NOT NULL DEFAULT 'Cash',
  items_json     JSONB  NOT NULL DEFAULT '[]',
  receipt_id     TEXT   NOT NULL DEFAULT '',
  receipt_url    TEXT   NOT NULL DEFAULT '',
  UNIQUE (business_id, sale_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_sales_biz_date ON sales_sales (business_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_sales_customer ON sales_sales (business_id, customer_id);

-- SaleItems (line items; one row per product per price-batch)
CREATE TABLE IF NOT EXISTS sales_sale_items (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sale_id     TEXT   NOT NULL,
  product_id  TEXT   NOT NULL DEFAULT '',
  product_name TEXT  NOT NULL DEFAULT '',
  qty         NUMERIC(14,2) NOT NULL DEFAULT 0,
  price       NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total  NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_price  NUMERIC(14,2) NOT NULL DEFAULT 0,
  profit      NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sales_sale_items_sale ON sales_sale_items (business_id, sale_id);

-- Expenses / stock batches (FIFO). One row per purchase batch.
CREATE TABLE IF NOT EXISTS sales_expenses (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expense_id    TEXT   NOT NULL,          -- exp0001 ...
  date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  product_id    TEXT   NOT NULL DEFAULT '',
  product_name  TEXT   NOT NULL DEFAULT '',
  type          TEXT   NOT NULL DEFAULT 'New',  -- New | Restock | Opening
  qty           NUMERIC(14,2) NOT NULL DEFAULT 0,
  unit_cost     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_cost    NUMERIC(14,2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  qty_remaining NUMERIC(14,2) NOT NULL DEFAULT 0,
  sort_order    BIGINT NOT NULL DEFAULT 0,
  UNIQUE (business_id, expense_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_expenses_biz ON sales_expenses (business_id);
CREATE INDEX IF NOT EXISTS idx_sales_expenses_batch ON sales_expenses (business_id, product_id, sort_order);

-- Categories
CREATE TABLE IF NOT EXISTS sales_categories (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id TEXT   NOT NULL,            -- cat0001 ...
  name        TEXT   NOT NULL,
  type        TEXT   NOT NULL DEFAULT 'Product', -- Product | Expense
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (business_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_categories_biz ON sales_categories (business_id);
-- Prevent duplicate category names within a (business, type) so lazy seeding is race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_categories_name ON sales_categories (business_id, type, lower(name));

-- Running expenses (overheads)
CREATE TABLE IF NOT EXISTS sales_running_expenses (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expense_id  TEXT   NOT NULL,            -- rex0001 ...
  date        TIMESTAMPTZ NOT NULL DEFAULT now(),
  category    TEXT   NOT NULL DEFAULT 'Other',
  description TEXT   NOT NULL DEFAULT '',
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, expense_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_running_biz ON sales_running_expenses (business_id);

-- ---------------------------------------------------------------
-- SERVICES app tables
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS svc_settings (
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT   NOT NULL,
  value       TEXT   NOT NULL DEFAULT '',
  PRIMARY KEY (business_id, key)
);

CREATE TABLE IF NOT EXISTS svc_services (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id  TEXT   NOT NULL,            -- SVC0001 ...
  name        TEXT   NOT NULL,
  price       NUMERIC(14,2) NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (business_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_svc_services_biz ON svc_services (business_id);

CREATE TABLE IF NOT EXISTS svc_customers (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id TEXT   NOT NULL,            -- CUS0001 ...
  name        TEXT   NOT NULL DEFAULT '',
  phone       TEXT   NOT NULL DEFAULT '',
  address     TEXT   NOT NULL DEFAULT '',
  notes       TEXT   NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_svc_customers_biz ON svc_customers (business_id);
CREATE INDEX IF NOT EXISTS idx_svc_customers_phone ON svc_customers (business_id, phone);

CREATE TABLE IF NOT EXISTS svc_sales (
  id               BIGSERIAL PRIMARY KEY,
  business_id      BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sale_id          TEXT   NOT NULL,       -- SLS0001 ...
  receipt_no       TEXT   NOT NULL,       -- REC0001 ...
  date             TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id      TEXT   NOT NULL DEFAULT '',
  customer_name    TEXT   NOT NULL DEFAULT '',
  customer_phone   TEXT   NOT NULL DEFAULT '',
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount         NUMERIC(14,2) NOT NULL DEFAULT 0, -- percentage
  total            NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method   TEXT   NOT NULL DEFAULT 'Cash',
  status           TEXT   NOT NULL DEFAULT 'Completed',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  discount_percent NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (business_id, sale_id),
  UNIQUE (business_id, receipt_no)
);
CREATE INDEX IF NOT EXISTS idx_svc_sales_biz_date ON svc_sales (business_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_svc_sales_customer ON svc_sales (business_id, customer_id);

CREATE TABLE IF NOT EXISTS svc_sale_items (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_id       TEXT   NOT NULL,          -- ITM0001 ...
  sale_id       TEXT   NOT NULL,
  service_name  TEXT   NOT NULL DEFAULT '',
  qty           NUMERIC(14,2) NOT NULL DEFAULT 0,
  unit_price    NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (business_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_svc_sale_items_sale ON svc_sale_items (business_id, sale_id);

CREATE TABLE IF NOT EXISTS svc_expenses (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expense_id  TEXT   NOT NULL,            -- EXP0001 ...
  date        TIMESTAMPTZ NOT NULL DEFAULT now(),
  category    TEXT   NOT NULL DEFAULT 'General',
  description TEXT   NOT NULL DEFAULT '',
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, expense_id)
);
CREATE INDEX IF NOT EXISTS idx_svc_expenses_biz_date ON svc_expenses (business_id, date DESC);

CREATE TABLE IF NOT EXISTS svc_categories (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id TEXT   NOT NULL,            -- CAT0001 ...
  name        TEXT   NOT NULL,
  type        TEXT   NOT NULL DEFAULT 'Expense', -- Expense | (future)
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (business_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_svc_categories_biz ON svc_categories (business_id);

-- ---------------------------------------------------------------
-- Per-business ID counters (replaces the old "NextXxxNo" Config/Settings rows).
-- Each business keeps its own sequence, so IDs restart at 0001 per business exactly
-- as before. nextNumber() bumps the value atomically with INSERT ... ON CONFLICT.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counters (
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,   -- prd | cus | sal | rec | exp | cat | rex | svc | itm (services)
  value       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, name)
);
