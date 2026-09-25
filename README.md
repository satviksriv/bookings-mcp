# bookings-mcp

An MCP server that lets Claude run the front desk of a service business: it finds customers, checks real availability, books and cancels appointments without double-booking, and answers revenue questions from the actual data.

It ships with a demo dataset for **Maple Street Studio**, a fictional three-stylist salon (40 customers, six services, 60 days of history and two weeks of upcoming bookings), plus a Claude **skill** that tells Claude how to use the tools the way a good receptionist would.

> "Book Ava Patel for a haircut tomorrow afternoon with Priya."
> Claude searches the customer, checks Priya's open slots, offers three times, confirms, and books.
>
> "How did we do in August, and who had the most no-shows?"
> Claude runs `revenue_report` grouped by staff and answers in two sentences.

## Why it's built this way

| Decision | Reason |
| --- | --- |
| Business rules live in `src/domain.ts`, not in the tool handlers | Rules are unit-tested without the protocol, and the same logic could back a web app or n8n workflow |
| Bookings run in a transaction with an overlap check | Two requests for the same slot cannot both succeed |
| Rule violations return `isError` with a plain sentence | Claude reads "Marcus is already booked at that time. Call check_availability…" and recovers on its own |
| Tool annotations (`readOnlyHint`, `destructiveHint`) | Clients can auto-approve reads and ask before cancellations |
| No reschedule tool | The skill books the new slot before cancelling the old one, so a failure never leaves the customer with nothing |
| Node's built-in SQLite | No native build step, so it installs the same way on Windows, macOS and Linux |
| stdout reserved for protocol, logs to stderr | Stray `console.log` output is the most common way MCP servers break |

## Tools

| Tool | Type | What it does |
| --- | --- | --- |
| `search_customers` | read | Match on name, email or phone; shows last visit and upcoming bookings |
| `get_customer` | read | Profile, visit and spend totals, no-shows, 20 latest bookings |
| `create_customer` | write | Requires email or phone; blocks duplicate emails |
| `list_services` | read | Services with duration, price and qualified staff |
| `check_availability` | read | Open 15-minute start times per staff member, inside opening hours, never in the past |
| `create_booking` | write | Validates hours, staff skills and conflicts; auto-assigns a free stylist if none is named |
| `cancel_booking` | destructive | Future confirmed bookings only, reason required |
| `list_bookings` | read | Schedule for a date range, filterable by staff and status |
| `revenue_report` | read | Revenue, average ticket, no-show rate and cancellations by service, staff or day |

It also provides a `daily_briefing` prompt for a morning summary.

## Quick start

Requires Node.js 22.13 or later.

```bash
npm install
npm run build
npm test        # 31 tests: business rules + end-to-end over the MCP protocol
```

The first run creates `data/bookings.db` and fills it with demo data. Set `BOOKINGS_SEED_DEMO=false` to start empty, or `BOOKINGS_DB_PATH` to use another file.

### Claude Desktop

Add to `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`), using the absolute path to this folder:

```json
{
  "mcpServers": {
    "bookings": {
      "command": "node",
      "args": ["C:\\path\\to\\bookings-mcp\\dist\\index.js"],
      "env": { "BOOKINGS_DB_PATH": "C:\\path\\to\\bookings-mcp\\data\\bookings.db" }
    }
  }
}
```

Restart Claude Desktop, then add the skill: zip `skills/front-desk` and upload it under **Customize → Skills**.

### Claude Code

```bash
claude mcp add bookings -- node /absolute/path/to/bookings-mcp/dist/index.js
mkdir -p .claude/skills && cp -r skills/front-desk .claude/skills/
```

### Inspect the tools without Claude

```bash
npm run inspect
```

## Project layout

```
src/
  domain.ts   business rules: availability, booking, cancellation, reports
  server.ts   MCP tool and prompt definitions (thin wrappers over domain.ts)
  db.ts       schema and transaction helper
  seed.ts     deterministic demo data
  time.ts     local-time helpers
  index.ts    stdio entry point
skills/front-desk/SKILL.md   how Claude should use the tools
test/                        vitest suites
```

## Adapting it to a real business

Swap `src/db.ts` and the queries in `src/domain.ts` for the client's system (Google Calendar, Square, Fresha, a Postgres database or a REST API). The tool names, schemas, error messages and skill stay the same, so Claude's behaviour carries over unchanged. Opening hours live in `OPENING_HOURS` in `src/domain.ts`.

## License

MIT
