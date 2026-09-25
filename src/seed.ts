import { type DB, transaction } from "./db.js";
import { OPENING_HOURS, SLOT_STEP_MIN } from "./domain.js";
import { addDays, addMinutes, atMinutes, dayOfWeek } from "./time.js";

/**
 * Demo data for "Maple Street Studio", a fictional hair and beauty salon.
 * Deterministic for a given `today`, so tests and screenshots are repeatable:
 * 60 days of history (completed / no-show / cancelled) and 14 days of
 * confirmed upcoming bookings.
 */

const STAFF = ["Priya Shah", "Marcus Lee", "Elena Rossi"];

const SERVICES: [string, number, number, number[]][] = [
  // name, minutes, price (cents), staff indexes who perform it
  ["Haircut", 45, 4500, [0, 1, 2]],
  ["Colour & cut", 120, 14000, [0, 2]],
  ["Blow-dry", 30, 3000, [0, 1, 2]],
  ["Beard trim", 20, 2000, [1]],
  ["Highlights", 150, 18000, [2]],
  ["Scalp treatment", 60, 6500, [0]],
];

const FIRST = ["Ava", "Noah", "Mia", "Liam", "Zoe", "Ethan", "Isla", "Omar", "Chloe", "Ravi",
  "Grace", "Leo", "Hannah", "Sam", "Nora", "Arjun", "Lucy", "Ben", "Aisha", "Tom"];
const LAST = ["Patel", "Nguyen", "Brown", "Garcia", "Kim", "Wilson", "Khan", "Martin", "Lopez", "Clarke"];

/** Small seeded PRNG (mulberry32) so seeds are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedDemoData(db: DB, today: string): void {
  const rand = rng(20260925);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

  transaction(db, () => {
    const staffIds = STAFF.map(
      (name) => Number(db.prepare("INSERT INTO staff (name) VALUES (?)").run(name).lastInsertRowid),
    );

    const services = SERVICES.map(([name, dur, cents, who]) => {
      const id = Number(
        db.prepare("INSERT INTO services (name, duration_min, price_cents) VALUES (?, ?, ?)")
          .run(name, dur, cents).lastInsertRowid,
      );
      for (const i of who) {
        db.prepare("INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)").run(staffIds[i], id);
      }
      return { id, dur, cents, staff: who.map((i) => staffIds[i]) };
    });

    const customerIds: number[] = [];
    const created = `${addDays(today, -90)}T09:00`;
    for (let i = 0; i < 40; i++) {
      const first = FIRST[i % FIRST.length];
      // Offset the second pass through FIRST so every full name is unique.
      const last = LAST[(i * 7 + (i >= FIRST.length ? 5 : 0)) % LAST.length];
      const email = `${first}.${last}${i}@example.com`.toLowerCase();
      const phone = `+1-555-01${String(i).padStart(2, "0")}`;
      customerIds.push(
        Number(
          db.prepare("INSERT INTO customers (name, email, phone, notes, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(`${first} ${last}`, email, phone, i % 9 === 0 ? "Prefers morning appointments" : null, created)
            .lastInsertRowid,
        ),
      );
    }

    // Track each staff member's booked minutes per day to avoid overlaps.
    const busy = new Map<string, [number, number][]>();
    const isFree = (staff: number, date: string, s: number, e: number) =>
      !(busy.get(`${staff}|${date}`) ?? []).some(([a, b]) => s < b && e > a);
    const mark = (staff: number, date: string, s: number, e: number) => {
      const k = `${staff}|${date}`;
      busy.set(k, [...(busy.get(k) ?? []), [s, e]]);
    };

    const insert = db.prepare(
      `INSERT INTO bookings (customer_id, service_id, staff_id, start_at, end_at, status, price_cents, cancel_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let offset = -60; offset <= 14; offset++) {
      if (offset === 0) continue; // leave today open for live demos
      const date = addDays(today, offset);
      const hours = OPENING_HOURS[dayOfWeek(date)];
      if (!hours) continue;
      const perDay = offset < 0 ? 6 + Math.floor(rand() * 6) : 3 + Math.floor(rand() * 4);

      for (let n = 0; n < perDay; n++) {
        const svc = pick(services);
        const staff = pick(svc.staff);
        const lastStart = hours[1] - svc.dur;
        const slots = Math.floor((lastStart - hours[0]) / SLOT_STEP_MIN);
        const s = hours[0] + Math.floor(rand() * (slots + 1)) * SLOT_STEP_MIN;
        const e = s + svc.dur;
        if (!isFree(staff, date, s, e)) continue;
        mark(staff, date, s, e);

        const start = atMinutes(date, s);
        let status = "confirmed";
        let reason: string | null = null;
        if (offset < 0) {
          const r = rand();
          status = r < 0.84 ? "completed" : r < 0.92 ? "no_show" : "cancelled";
          if (status === "cancelled") reason = pick(["Illness", "Schedule clash", "Travel"]);
        }
        insert.run(pick(customerIds), svc.id, staff, start, addMinutes(start, svc.dur), status,
          svc.cents, reason, `${addDays(date, -7)}T12:00`);
      }
    }
  });
}
