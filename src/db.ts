import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,
  phone       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  duration_min  INTEGER NOT NULL CHECK (duration_min > 0),
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS staff_services (
  staff_id    INTEGER NOT NULL REFERENCES staff(id),
  service_id  INTEGER NOT NULL REFERENCES services(id),
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  service_id     INTEGER NOT NULL REFERENCES services(id),
  staff_id       INTEGER NOT NULL REFERENCES staff(id),
  start_at       TEXT NOT NULL,
  end_at         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('confirmed','completed','cancelled','no_show')),
  price_cents    INTEGER NOT NULL,
  cancel_reason  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_staff_time ON bookings(staff_id, start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer   ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_start      ON bookings(start_at);
`;

export function openDatabase(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function isEmpty(db: DB): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM services").get() as { n: number };
  return row.n === 0;
}

/** Run fn inside a transaction; roll back on any error. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
