-- Store All Valet — MVP schema
-- Six tables. TEXT ids and ISO-string timestamps throughout, deliberately,
-- so the schema lifts cleanly to Postgres later (see README migration note).

CREATE TABLE IF NOT EXISTS customers (
  id                  TEXT PRIMARY KEY,        -- e.g. cust_001
  sitelink_tenant_id  TEXT UNIQUE,             -- 6-digit SiteLink Tenant ID, e.g. 236692; nullable
  name                TEXT,
  phone               TEXT,
  email               TEXT,
  address             TEXT,                    -- delivery/collection address
  created_at          TEXT
);

CREATE TABLE IF NOT EXISTS bins (
  id           TEXT PRIMARY KEY,
  barcode      TEXT UNIQUE NOT NULL,           -- permanent physical label, e.g. BIN1007
  sku_type     TEXT,                           -- bin | wardrobe | odd
  status       TEXT,                           -- one of the seven statuses (NULL/unassigned at start)
  customer_id  TEXT REFERENCES customers(id),  -- null until assigned to a booking
  booking_id   TEXT REFERENCES bookings(id),   -- null until assigned
  location_id  TEXT REFERENCES locations(id),  -- null unless Stored
  photo_ref    TEXT                            -- stub string for the intake photo
);

CREATE TABLE IF NOT EXISTS locations (
  id        TEXT PRIMARY KEY,
  barcode   TEXT UNIQUE NOT NULL,              -- rack slot label, e.g. A-02-1-01
  occupied  INTEGER DEFAULT 0                  -- 0/1
);

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT REFERENCES customers(id),
  bin_count      INTEGER,
  sku_breakdown  TEXT,                          -- JSON, e.g. {"bin":3,"wardrobe":1}
  status         TEXT,                          -- display-only / derived; NEVER the source of truth
  delivery_date  TEXT,                          -- requested date to deliver empty bins
  created_at     TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT REFERENCES bookings(id),
  type            TEXT,                          -- deliver_empty | collect_full | deliver_back
  status          TEXT,                          -- Scheduled | Done
  scheduled_date  TEXT,
  bin_ids         TEXT                           -- JSON array of bin ids involved
);

-- The event log / chain of custody. Every scan and status change writes one row.
CREATE TABLE IF NOT EXISTS movements (
  id           TEXT PRIMARY KEY,
  bin_id       TEXT REFERENCES bins(id),
  from_status  TEXT,
  to_status    TEXT,
  location_id  TEXT REFERENCES locations(id),   -- null unless a put-away
  actor        TEXT,                             -- customer | admin
  job_id       TEXT REFERENCES jobs(id),         -- null if not part of a job
  ts           TEXT                              -- ISO timestamp
);
