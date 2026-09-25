import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { seedDemoData } from "../src/seed.js";
import { createServer } from "../src/server.js";

const TODAY = "2026-09-28";
let client: Client;

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as TextResult;
  return { isError: r.isError ?? false, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
}

beforeEach(async () => {
  const db = openDatabase(":memory:");
  seedDemoData(db, TODAY);
  const server = createServer(db, { now: () => `${TODAY}T08:00` });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

describe("MCP server over the protocol", () => {
  it("exposes nine tools with read-only hints set correctly", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_booking",
      "check_availability",
      "create_booking",
      "create_customer",
      "get_customer",
      "list_bookings",
      "list_services",
      "revenue_report",
      "search_customers",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).not.toContain("create_booking");
    expect(tools.find((t) => t.name === "cancel_booking")?.annotations?.destructiveHint).toBe(true);
  });

  it("runs the front-desk flow: find customer, check slots, book, report", async () => {
    const customers = (await call("search_customers", { query: "patel" })).json();
    expect(customers.length).toBeGreaterThan(0);

    const services = (await call("list_services")).json();
    const haircut = services.find((s: { name: string }) => s.name === "Haircut");

    const avail = (await call("check_availability", { date: TODAY, service_id: haircut.id })).json();
    const slot = avail.slots[0];

    const booking = await call("create_booking", {
      customer_id: customers[0].id,
      service_id: haircut.id,
      start: slot.start,
      staff_id: slot.staff_id,
    });
    expect(booking.isError).toBe(false);
    expect(booking.json()).toMatchObject({ status: "confirmed", staff: slot.staff });

    const day = (await call("list_bookings", { from: TODAY, to: TODAY })).json();
    expect(day).toHaveLength(1);

    const report = (await call("revenue_report", { from: "2026-09-01", to: "2026-09-30", group_by: "staff" })).json();
    expect(report.totals.upcoming_confirmed).toBeGreaterThan(0);
  });

  it("returns business-rule failures as tool errors Claude can read", async () => {
    const r = await call("create_booking", { customer_id: 1, service_id: 1, start: "2026-09-27T10:00" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/past/);
  });

  it("rejects malformed input at the schema layer", async () => {
    const r = await call("check_availability", { date: "tomorrow", service_id: 1 });
    expect(r.isError).toBe(true);
  });

  it("serves the daily_briefing prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("daily_briefing");
    const p = await client.getPrompt({ name: "daily_briefing", arguments: {} });
    expect(JSON.stringify(p.messages)).toContain(TODAY);
  });
});
