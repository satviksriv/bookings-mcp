import { type DB, transaction } from "./db.js";
import {
  addMinutes,
  atMinutes,
  dayOfWeek,
  isDate,
  isDateTime,
  minutesOfDay,
} from "./time.js";

/** A rule violation the caller (usually Claude) should see and can act on. */
export class DomainError extends Error {}

/** Opening hours by day of week (0 = Sunday). null = closed. */
export const OPENING_HOURS: Record<number, [number, number] | null> = {
  0: null,
  1: [9 * 60, 18 * 60],
  2: [9 * 60, 18 * 60],
  3: [9 * 60, 18 * 60],
  4: [9 * 60, 20 * 60],
  5: [9 * 60, 20 * 60],
  6: [9 * 60, 16 * 60],
};

export const SLOT_STEP_MIN = 15;

const money = (cents: number) => Math.round(cents) / 100;

// ---------------------------------------------------------------- customers

export interface CustomerInput {
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
}

export function searchCustomers(db: DB, query: string, limit = 10) {
  const q = `%${query.trim().toLowerCase()}%`;
  return db
    .prepare(
      `SELECT c.id, c.name, c.email, c.phone,
              (SELECT MAX(b.start_at) FROM bookings b
                 WHERE b.customer_id = c.id AND b.status = 'completed') AS last_visit,
              (SELECT COUNT(*) FROM bookings b
                 WHERE b.customer_id = c.id AND b.status = 'confirmed') AS upcoming_bookings
         FROM customers c
        WHERE lower(c.name) LIKE ? OR lower(c.email) LIKE ? OR c.phone LIKE ?
        ORDER BY c.name
        LIMIT ?`,
    )
    .all(q, q, q, limit);
}

export function getCustomer(db: DB, id: number) {
  const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
  if (!customer) throw new DomainError(`No customer with id ${id}.`);

  const bookings = db
    .prepare(
      `SELECT b.id, b.start_at, b.status, s.name AS service, st.name AS staff,
              b.price_cents / 100.0 AS price
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN staff st   ON st.id = b.staff_id
        WHERE b.customer_id = ?
        ORDER BY b.start_at DESC
        LIMIT 20`,
    )
    .all(id);

  const stats = db
    .prepare(
      `SELECT
         SUM(status = 'completed')                              AS visits,
         SUM(CASE WHEN status = 'completed' THEN price_cents END) AS spend_cents,
         SUM(status = 'no_show')                                AS no_shows,
         SUM(status = 'cancelled')                              AS cancellations
       FROM bookings WHERE customer_id = ?`,
    )
    .get(id) as Record<string, number | null>;

  return {
    customer,
    stats: {
      visits: stats.visits ?? 0,
      total_spend: money(stats.spend_cents ?? 0),
      no_shows: stats.no_shows ?? 0,
      cancellations: stats.cancellations ?? 0,
    },
    recent_bookings: bookings,
  };
}

export function createCustomer(db: DB, input: CustomerInput, now: string) {
  const name = input.name.trim();
  if (!name) throw new DomainError("Customer name is required.");
  const email = input.email?.trim().toLowerCase() || null;
  if (!email && !input.phone?.trim()) {
    throw new DomainError("Give at least an email or a phone number so the customer can be contacted.");
  }
  if (email) {
    const existing = db.prepare("SELECT id, name FROM customers WHERE email = ?").get(email) as
      | { id: number; name: string }
      | undefined;
    if (existing) {
      throw new DomainError(
        `A customer with email ${email} already exists (id ${existing.id}, ${existing.name}). Use that record instead.`,
      );
    }
  }
  const result = db
    .prepare("INSERT INTO customers (name, email, phone, notes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, input.phone?.trim() || null, input.notes?.trim() || null, now);
  return { id: Number(result.lastInsertRowid), name, email, phone: input.phone ?? null };
}

// ----------------------------------------------------------------- services

export function listServices(db: DB) {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.duration_min, s.price_cents / 100.0 AS price,
              group_concat(st.name, ', ') AS staff
         FROM services s
         LEFT JOIN staff_services ss ON ss.service_id = s.id
         LEFT JOIN staff st ON st.id = ss.staff_id AND st.active = 1
        WHERE s.active = 1
        GROUP BY s.id
        ORDER BY s.name`,
    )
    .all();
  return rows;
}

interface ServiceRow {
  id: number;
  name: string;
  duration_min: number;
  price_cents: number;
}

function requireService(db: DB, id: number): ServiceRow {
  const s = db
    .prepare("SELECT id, name, duration_min, price_cents FROM services WHERE id = ? AND active = 1")
    .get(id) as ServiceRow | undefined;
  if (!s) throw new DomainError(`No active service with id ${id}. Call list_services to see valid ids.`);
  return s;
}

function qualifiedStaff(db: DB, serviceId: number, staffId?: number) {
  const rows = db
    .prepare(
      `SELECT st.id, st.name FROM staff st
         JOIN staff_services ss ON ss.staff_id = st.id
        WHERE ss.service_id = ? AND st.active = 1
        ORDER BY st.id`,
    )
    .all(serviceId) as { id: number; name: string }[];
  if (staffId === undefined) return rows;
  const match = rows.filter((r) => r.id === staffId);
  if (match.length === 0) {
    throw new DomainError(`Staff member ${staffId} does not perform this service.`);
  }
  return match;
}

function hasConflict(db: DB, staffId: number, start: string, end: string, ignoreBookingId = -1) {
  const row = db
    .prepare(
      `SELECT id FROM bookings
        WHERE staff_id = ? AND status = 'confirmed'
          AND start_at < ? AND end_at > ? AND id != ?
        LIMIT 1`,
    )
    .get(staffId, end, start, ignoreBookingId);
  return row !== undefined;
}

// ------------------------------------------------------------- availability

export interface AvailabilityInput {
  date: string;
  serviceId: number;
  staffId?: number;
}

export function findAvailability(db: DB, input: AvailabilityInput, now: string) {
  if (!isDate(input.date)) throw new DomainError("date must be YYYY-MM-DD.");
  const service = requireService(db, input.serviceId);
  const hours = OPENING_HOURS[dayOfWeek(input.date)];
  if (!hours) return { date: input.date, service: service.name, closed: true, slots: [] };

  const [open, close] = hours;
  const slots: { staff_id: number; staff: string; start: string; end: string }[] = [];

  for (const person of qualifiedStaff(db, service.id, input.staffId)) {
    for (let m = open; m + service.duration_min <= close; m += SLOT_STEP_MIN) {
      const start = atMinutes(input.date, m);
      if (start <= now) continue;
      const end = addMinutes(start, service.duration_min);
      if (!hasConflict(db, person.id, start, end)) {
        slots.push({ staff_id: person.id, staff: person.name, start, end });
      }
    }
  }
  slots.sort((a, b) => a.start.localeCompare(b.start) || a.staff_id - b.staff_id);
  return {
    date: input.date,
    service: service.name,
    duration_min: service.duration_min,
    closed: false,
    slots,
  };
}

// ----------------------------------------------------------------- bookings

export interface BookingInput {
  customerId: number;
  serviceId: number;
  start: string;
  staffId?: number;
}

export function createBooking(db: DB, input: BookingInput, now: string) {
  if (!isDateTime(input.start)) throw new DomainError("start must be YYYY-MM-DDTHH:MM (business local time).");
  if (input.start <= now) throw new DomainError(`Cannot book in the past (now is ${now}).`);

  return transaction(db, () => {
    const customer = db.prepare("SELECT id, name FROM customers WHERE id = ?").get(input.customerId) as
      | { id: number; name: string }
      | undefined;
    if (!customer) throw new DomainError(`No customer with id ${input.customerId}.`);

    const service = requireService(db, input.serviceId);
    const date = input.start.slice(0, 10);
    const hours = OPENING_HOURS[dayOfWeek(date)];
    if (!hours) throw new DomainError(`The business is closed on ${date}.`);

    const startMin = minutesOfDay(input.start);
    if (startMin % SLOT_STEP_MIN !== 0) {
      throw new DomainError(`Start times must be on a ${SLOT_STEP_MIN}-minute boundary.`);
    }
    if (startMin < hours[0] || startMin + service.duration_min > hours[1]) {
      throw new DomainError(
        `${service.name} (${service.duration_min} min) at ${input.start.slice(11)} falls outside opening hours ` +
          `${atMinutes(date, hours[0]).slice(11)}–${atMinutes(date, hours[1]).slice(11)}.`,
      );
    }

    const end = addMinutes(input.start, service.duration_min);
    const candidates = qualifiedStaff(db, service.id, input.staffId);
    const free = candidates.find((p) => !hasConflict(db, p.id, input.start, end));
    if (!free) {
      throw new DomainError(
        input.staffId !== undefined
          ? `${candidates[0].name} is already booked at that time. Call check_availability for open slots.`
          : "No qualified staff are free at that time. Call check_availability for open slots.",
      );
    }

    const result = db
      .prepare(
        `INSERT INTO bookings (customer_id, service_id, staff_id, start_at, end_at, status, price_cents, created_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
      )
      .run(customer.id, service.id, free.id, input.start, end, service.price_cents, now);

    return {
      booking_id: Number(result.lastInsertRowid),
      customer: customer.name,
      service: service.name,
      staff: free.name,
      start: input.start,
      end,
      price: money(service.price_cents),
      status: "confirmed",
    };
  });
}

export function cancelBooking(db: DB, bookingId: number, reason: string, now: string) {
  const b = db.prepare("SELECT id, status, start_at FROM bookings WHERE id = ?").get(bookingId) as
    | { id: number; status: string; start_at: string }
    | undefined;
  if (!b) throw new DomainError(`No booking with id ${bookingId}.`);
  if (b.status !== "confirmed") throw new DomainError(`Booking ${bookingId} is already ${b.status}.`);
  if (b.start_at <= now) throw new DomainError(`Booking ${bookingId} has already started; mark it completed or no-show instead.`);
  if (!reason.trim()) throw new DomainError("A cancellation reason is required.");

  db.prepare("UPDATE bookings SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(reason.trim(), bookingId);
  return { booking_id: bookingId, status: "cancelled", reason: reason.trim() };
}

export interface ScheduleInput {
  from: string;
  to: string;
  staffId?: number;
  status?: "confirmed" | "completed" | "cancelled" | "no_show";
}

export function listBookings(db: DB, input: ScheduleInput) {
  if (!isDate(input.from) || !isDate(input.to)) throw new DomainError("from and to must be YYYY-MM-DD.");
  if (input.to < input.from) throw new DomainError("to must be on or after from.");
  const params: (string | number)[] = [`${input.from}T00:00`, `${input.to}T23:59`];
  let sql = `SELECT b.id, b.start_at, b.end_at, b.status, c.name AS customer, c.phone,
                    s.name AS service, st.name AS staff, b.price_cents / 100.0 AS price
               FROM bookings b
               JOIN customers c ON c.id = b.customer_id
               JOIN services s  ON s.id = b.service_id
               JOIN staff st    ON st.id = b.staff_id
              WHERE b.start_at >= ? AND b.start_at <= ?`;
  if (input.staffId !== undefined) {
    sql += " AND b.staff_id = ?";
    params.push(input.staffId);
  }
  if (input.status) {
    sql += " AND b.status = ?";
    params.push(input.status);
  }
  sql += " ORDER BY b.start_at, st.name LIMIT 500";
  return db.prepare(sql).all(...params);
}

// ------------------------------------------------------------------ reports

export type GroupBy = "service" | "staff" | "day";

export function revenueReport(db: DB, from: string, to: string, groupBy: GroupBy) {
  if (!isDate(from) || !isDate(to)) throw new DomainError("from and to must be YYYY-MM-DD.");
  if (to < from) throw new DomainError("to must be on or after from.");

  const key = {
    service: "s.name",
    staff: "st.name",
    day: "substr(b.start_at, 1, 10)",
  }[groupBy];

  const range = [`${from}T00:00`, `${to}T23:59`];

  const rows = db
    .prepare(
      `SELECT ${key} AS grp,
              SUM(b.status = 'completed')                                  AS completed,
              SUM(CASE WHEN b.status = 'completed' THEN b.price_cents END) AS revenue_cents,
              SUM(b.status = 'no_show')                                    AS no_shows,
              SUM(b.status = 'cancelled')                                  AS cancelled
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN staff st   ON st.id = b.staff_id
        WHERE b.start_at >= ? AND b.start_at <= ?
        GROUP BY grp
        ORDER BY ${groupBy === "day" ? "grp" : "revenue_cents DESC"}`,
    )
    .all(...range) as {
    grp: string;
    completed: number;
    revenue_cents: number | null;
    no_shows: number;
    cancelled: number;
  }[];

  const booked = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(price_cents) AS cents FROM bookings
        WHERE status = 'confirmed' AND start_at >= ? AND start_at <= ?`,
    )
    .get(...range) as { n: number; cents: number | null };

  const totals = rows.reduce(
    (t, r) => ({
      completed: t.completed + r.completed,
      revenue_cents: t.revenue_cents + (r.revenue_cents ?? 0),
      no_shows: t.no_shows + r.no_shows,
      cancelled: t.cancelled + r.cancelled,
    }),
    { completed: 0, revenue_cents: 0, no_shows: 0, cancelled: 0 },
  );
  const attended = totals.completed + totals.no_shows;

  return {
    from,
    to,
    group_by: groupBy,
    currency: "USD",
    totals: {
      revenue: money(totals.revenue_cents),
      completed_bookings: totals.completed,
      average_ticket: totals.completed ? money(totals.revenue_cents / totals.completed) : 0,
      no_shows: totals.no_shows,
      no_show_rate: attended ? Number((totals.no_shows / attended).toFixed(3)) : 0,
      cancellations: totals.cancelled,
      upcoming_confirmed: booked.n,
      upcoming_value: money(booked.cents ?? 0),
    },
    rows: rows.map((r) => ({
      [groupBy]: r.grp,
      revenue: money(r.revenue_cents ?? 0),
      completed: r.completed,
      no_shows: r.no_shows,
      cancelled: r.cancelled,
    })),
  };
}
