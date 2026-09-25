import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openDatabase } from "../src/db.js";
import {
  DomainError,
  cancelBooking,
  createBooking,
  createCustomer,
  findAvailability,
  getCustomer,
  listBookings,
  revenueReport,
  searchCustomers,
} from "../src/domain.js";
import { seedDemoData } from "../src/seed.js";

// Monday 28 Sep 2026, 08:00 — before opening, so the whole day is bookable.
const TODAY = "2026-09-28";
const NOW = `${TODAY}T08:00`;
const SUNDAY = "2026-09-27";

let db: DB;
let haircut: number;
let beardTrim: number;
let customer: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  seedDemoData(db, TODAY);
  const svc = (name: string) =>
    (db.prepare("SELECT id FROM services WHERE name = ?").get(name) as { id: number }).id;
  haircut = svc("Haircut");
  beardTrim = svc("Beard trim");
  customer = (db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get() as { id: number }).id;
});

describe("seed data", () => {
  it("never double-books a staff member", () => {
    const overlaps = db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings a JOIN bookings b
           ON a.staff_id = b.staff_id AND a.id < b.id
          AND a.start_at < b.end_at AND a.end_at > b.start_at`,
      )
      .get() as { n: number };
    expect(overlaps.n).toBe(0);
  });

  it("is deterministic for the same date", () => {
    const other = openDatabase(":memory:");
    seedDemoData(other, TODAY);
    const sig = (d: DB) => d.prepare("SELECT group_concat(start_at || status, ',') AS s FROM bookings").get();
    expect(sig(other)).toEqual(sig(db));
  });

  it("gives every customer a unique name", () => {
    const dupes = db.prepare("SELECT name FROM customers GROUP BY name HAVING COUNT(*) > 1").all();
    expect(dupes).toEqual([]);
  });

  it("leaves today empty for live demos", () => {
    expect(listBookings(db, { from: TODAY, to: TODAY })).toHaveLength(0);
  });
});

describe("availability", () => {
  it("reports Sundays as closed", () => {
    const r = findAvailability(db, { date: SUNDAY, serviceId: haircut }, NOW);
    expect(r.closed).toBe(true);
    expect(r.slots).toEqual([]);
  });

  it("only offers slots that fit before closing", () => {
    const r = findAvailability(db, { date: TODAY, serviceId: haircut }, NOW);
    // Monday closes 18:00; a 45-minute haircut can start 17:15 at the latest.
    const starts = r.slots.map((s) => s.start.slice(11));
    expect(starts).toContain("17:15");
    expect(starts).not.toContain("17:30");
    expect(starts[0]).toBe("09:00");
  });

  it("excludes past times", () => {
    const r = findAvailability(db, { date: TODAY, serviceId: haircut }, `${TODAY}T12:05`);
    expect(r.slots.every((s) => s.start > `${TODAY}T12:05`)).toBe(true);
  });

  it("removes a slot once it is booked", () => {
    const beard = findAvailability(db, { date: TODAY, serviceId: beardTrim }, NOW);
    expect(beard.slots.some((s) => s.start.endsWith("10:00"))).toBe(true);
    createBooking(db, { customerId: customer, serviceId: beardTrim, start: `${TODAY}T10:00` }, NOW);
    const after = findAvailability(db, { date: TODAY, serviceId: beardTrim }, NOW);
    // Only one person does beard trims, so 09:45 (overlaps) and 10:00 disappear.
    const starts = after.slots.map((s) => s.start.slice(11));
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("09:45");
    expect(starts).not.toContain("10:15");
    expect(starts).toContain("10:30");
  });
});

describe("bookings", () => {
  const book = (start: string, staffId?: number, serviceId = haircut) =>
    createBooking(db, { customerId: customer, serviceId, start, staffId }, NOW);

  it("creates a confirmed booking with price and end time", () => {
    const b = book(`${TODAY}T11:00`);
    expect(b).toMatchObject({ status: "confirmed", end: `${TODAY}T11:45`, price: 45 });
  });

  it("assigns the next free qualified staff member when one is busy", () => {
    const first = book(`${TODAY}T11:00`);
    const second = book(`${TODAY}T11:00`);
    const third = book(`${TODAY}T11:00`);
    expect(new Set([first.staff, second.staff, third.staff]).size).toBe(3);
    expect(() => book(`${TODAY}T11:15`)).toThrow(/No qualified staff are free/);
  });

  it("rejects a double-booking for a named staff member", () => {
    const b = book(`${TODAY}T14:00`);
    const staffId = (db.prepare("SELECT staff_id FROM bookings WHERE id = ?").get(b.booking_id) as { staff_id: number })
      .staff_id;
    expect(() => book(`${TODAY}T14:30`, staffId)).toThrow(/already booked/);
  });

  it.each([
    ["2026-09-29T07:00", /outside opening hours/],
    [`${TODAY}T17:30`, /outside opening hours/],
    [`${TODAY}T10:10`, /15-minute boundary/],
    [`${SUNDAY}T10:00`, /past/],
    ["2026-10-04T10:00", /closed/],
    ["2026-13-01T10:00", /YYYY-MM-DDTHH:MM/],
  ])("rejects %s", (start, message) => {
    expect(() => book(start)).toThrow(message);
  });

  it("rejects staff who do not perform the service", () => {
    const priya = (db.prepare("SELECT id FROM staff WHERE name = 'Priya Shah'").get() as { id: number }).id;
    expect(() => book(`${TODAY}T10:00`, priya, beardTrim)).toThrow(/does not perform/);
  });

  it("rolls back fully when a booking fails", () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n;
    expect(() => createBooking(db, { customerId: 999999, serviceId: haircut, start: `${TODAY}T10:00` }, NOW)).toThrow(
      DomainError,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n).toBe(before);
  });

  it("cancels a future booking once, with a reason", () => {
    const b = book(`${TODAY}T15:00`);
    expect(() => cancelBooking(db, b.booking_id, "  ", NOW)).toThrow(/reason is required/);
    expect(cancelBooking(db, b.booking_id, "Customer is ill", NOW).status).toBe("cancelled");
    expect(() => cancelBooking(db, b.booking_id, "again", NOW)).toThrow(/already cancelled/);
    // The slot is free again.
    expect(() => book(`${TODAY}T15:00`, undefined)).not.toThrow();
  });

  it("will not cancel a booking that has started", () => {
    const b = book(`${TODAY}T09:00`);
    expect(() => cancelBooking(db, b.booking_id, "late", `${TODAY}T09:10`)).toThrow(/already started/);
  });
});

describe("customers", () => {
  it("finds customers by name, email or phone", () => {
    expect(searchCustomers(db, "patel").length).toBeGreaterThan(0);
    expect(searchCustomers(db, "@example.com", 5)).toHaveLength(5);
    expect(searchCustomers(db, "555-0107")).toHaveLength(1);
  });

  it("blocks duplicate emails and requires a contact method", () => {
    const existing = db.prepare("SELECT email FROM customers LIMIT 1").get() as { email: string };
    expect(() => createCustomer(db, { name: "Dup", email: existing.email.toUpperCase() }, NOW)).toThrow(/already exists/);
    expect(() => createCustomer(db, { name: "No contact" }, NOW)).toThrow(/email or a phone/);
    const c = createCustomer(db, { name: "  New Person ", phone: "+1-555-9999" }, NOW);
    expect(c.name).toBe("New Person");
  });

  it("summarises visits and spend from completed bookings only", () => {
    const profile = getCustomer(db, customer);
    const expected = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents),0) AS c FROM bookings WHERE customer_id = ? AND status='completed'")
      .get(customer) as { n: number; c: number };
    expect(profile.stats.visits).toBe(expected.n);
    expect(profile.stats.total_spend).toBe(expected.c / 100);
  });
});

describe("revenue report", () => {
  const from = "2026-08-01";
  const to = "2026-09-27";

  it("grouped rows add up to the totals for every grouping", () => {
    for (const g of ["service", "staff", "day"] as const) {
      const r = revenueReport(db, from, to, g);
      const sum = r.rows.reduce((t, row) => t + row.revenue, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(r.totals.revenue * 100));
    }
  });

  it("matches a direct query of completed bookings", () => {
    const r = revenueReport(db, from, to, "service");
    const direct = db
      .prepare(
        "SELECT SUM(price_cents) AS c, COUNT(*) AS n FROM bookings WHERE status='completed' AND start_at >= ? AND start_at <= ?",
      )
      .get(`${from}T00:00`, `${to}T23:59`) as { c: number; n: number };
    expect(r.totals.revenue).toBe(direct.c / 100);
    expect(r.totals.completed_bookings).toBe(direct.n);
    expect(r.totals.no_show_rate).toBeGreaterThan(0);
    expect(r.totals.no_show_rate).toBeLessThan(0.25);
  });

  it("rejects an inverted range", () => {
    expect(() => revenueReport(db, to, from, "day")).toThrow(/on or after/);
  });
});
