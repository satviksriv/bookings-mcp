import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DB } from "./db.js";
import {
  DomainError,
  cancelBooking,
  createBooking,
  createCustomer,
  findAvailability,
  getCustomer,
  listBookings,
  listServices,
  revenueReport,
  searchCustomers,
} from "./domain.js";
import { localNow } from "./time.js";

export interface ServerOptions {
  /** Clock override so tests are deterministic. Returns "YYYY-MM-DDTHH:MM". */
  now?: () => string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * Run a tool body. Business-rule failures come back as tool errors with a
 * plain message Claude can act on; anything unexpected is logged to stderr
 * (stdout is reserved for the MCP protocol) and reported generically.
 */
function run(fn: () => unknown): ToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(fn(), null, 2) }] };
  } catch (err) {
    if (err instanceof DomainError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    console.error("[bookings-mcp] unexpected error:", err);
    return { content: [{ type: "text", text: "Internal error; see server logs." }], isError: true };
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD");
const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .describe("Business local time as YYYY-MM-DDTHH:MM");
const id = z.number().int().positive();

export function createServer(db: DB, opts: ServerOptions = {}): McpServer {
  const now = opts.now ?? localNow;
  const server = new McpServer({ name: "bookings-mcp", version: "1.0.0" });

  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "search_customers",
    {
      title: "Search customers",
      description:
        "Find customers by part of their name, email or phone. Returns id, contact details, last visit and number of upcoming bookings. Use this before creating a customer to avoid duplicates.",
      inputSchema: {
        query: z.string().min(1).describe("Name, email or phone fragment"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: readOnly,
    },
    ({ query, limit }) => run(() => searchCustomers(db, query, limit)),
  );

  server.registerTool(
    "get_customer",
    {
      title: "Get customer profile",
      description: "Full profile for one customer: contact details, notes, visit and spend totals, no-shows, and the 20 most recent bookings.",
      inputSchema: { customer_id: id },
      annotations: readOnly,
    },
    ({ customer_id }) => run(() => getCustomer(db, customer_id)),
  );

  server.registerTool(
    "create_customer",
    {
      title: "Create customer",
      description: "Add a new customer. Requires a name and at least an email or phone. Fails if the email already exists.",
      inputSchema: {
        name: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        notes: z.string().max(500).optional().describe("Preferences, allergies to products, etc."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => run(() => createCustomer(db, args, now())),
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "All bookable services with id, duration in minutes, price in USD, and which staff perform them.",
      inputSchema: {},
      annotations: readOnly,
    },
    () => run(() => listServices(db)),
  );

  server.registerTool(
    "check_availability",
    {
      title: "Check availability",
      description:
        "Open start times for a service on a date, per qualified staff member, in 15-minute steps within opening hours. Past times are excluded. Returns closed=true on days the business is shut.",
      inputSchema: {
        date,
        service_id: id,
        staff_id: id.optional().describe("Only this staff member"),
      },
      annotations: readOnly,
    },
    ({ date, service_id, staff_id }) =>
      run(() => findAvailability(db, { date, serviceId: service_id, staffId: staff_id }, now())),
  );

  server.registerTool(
    "create_booking",
    {
      title: "Create booking",
      description:
        "Book a customer for a service. If staff_id is omitted, the first qualified free staff member is assigned. Rejects past times, closed days, times outside opening hours and double-bookings. Confirm the details with the user before calling.",
      inputSchema: {
        customer_id: id,
        service_id: id,
        start: dateTime,
        staff_id: id.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ customer_id, service_id, start, staff_id }) =>
      run(() => createBooking(db, { customerId: customer_id, serviceId: service_id, start, staffId: staff_id }, now())),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel booking",
      description: "Cancel a future confirmed booking. A reason is required and stored. Confirm with the user before calling.",
      inputSchema: {
        booking_id: id,
        reason: z.string().min(1).max(200),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ booking_id, reason }) => run(() => cancelBooking(db, booking_id, reason, now())),
  );

  server.registerTool(
    "list_bookings",
    {
      title: "List bookings",
      description: "Bookings between two dates (inclusive), with customer, phone, service, staff and status. Use for day schedules and follow-up lists. Max 500 rows.",
      inputSchema: {
        from: date,
        to: date,
        staff_id: id.optional(),
        status: z.enum(["confirmed", "completed", "cancelled", "no_show"]).optional(),
      },
      annotations: readOnly,
    },
    ({ from, to, staff_id, status }) => run(() => listBookings(db, { from, to, staffId: staff_id, status })),
  );

  server.registerTool(
    "revenue_report",
    {
      title: "Revenue report",
      description:
        "Revenue from completed bookings between two dates, grouped by service, staff or day, with totals, average ticket, no-show rate, cancellations, and the value of confirmed upcoming bookings in the range. Amounts in USD.",
      inputSchema: {
        from: date,
        to: date,
        group_by: z.enum(["service", "staff", "day"]).default("service"),
      },
      annotations: readOnly,
    },
    ({ from, to, group_by }) => run(() => revenueReport(db, from, to, group_by)),
  );

  server.registerPrompt(
    "daily_briefing",
    {
      title: "Daily briefing",
      description: "Summarise a day's schedule, gaps worth filling, and customers to follow up with.",
      argsSchema: { date: z.string().describe("YYYY-MM-DD; defaults to today").optional() },
    },
    ({ date: d }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Prepare the front-desk briefing for ${d ?? now().slice(0, 10)}. ` +
              "Use list_bookings for that date, then: (1) list appointments by staff member in time order; " +
              "(2) flag gaps of 60+ minutes that could take a Haircut or Blow-dry; " +
              "(3) flag customers with any past no-shows (get_customer) so we can send a reminder. " +
              "Keep it under 200 words.",
          },
        },
      ],
    }),
  );

  return server;
}
