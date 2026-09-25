#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isEmpty, openDatabase } from "./db.js";
import { seedDemoData } from "./seed.js";
import { createServer } from "./server.js";
import { localNow } from "./time.js";

const dbPath = resolve(process.env.BOOKINGS_DB_PATH ?? "./data/bookings.db");
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDatabase(dbPath);
if (isEmpty(db) && process.env.BOOKINGS_SEED_DEMO !== "false") {
  seedDemoData(db, localNow().slice(0, 10));
  console.error(`[bookings-mcp] seeded demo data into ${dbPath}`);
}

const server = createServer(db);
await server.connect(new StdioServerTransport());
console.error(`[bookings-mcp] ready (db: ${dbPath})`);
