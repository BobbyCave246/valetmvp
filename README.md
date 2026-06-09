# Store All Valet — MVP

A local-first prototype that simulates the full valet-bin lifecycle: a customer
books storage → we deliver empty bins → they're filled → collected → racked in
the warehouse → retrieved on demand → returned or closed. Built to validate the
**flow and the data model**, not for production (no cloud, no auth, no payments,
no real camera scanning — barcodes are typed or clicked).

## Stack

- **Datastore:** SQLite (single file `valet.db`)
- **Backend:** Node + Express + `better-sqlite3` (plain JS / ESM)
- **Frontends:** two vanilla HTML/JS/CSS apps served by Express
  - Public booking site → `/booking/`
  - Combined admin / warehouse console → `/admin/`

**Architectural rule:** the frontend never touches the DB. All reads/writes go
through `/api`, and *every* bin-status change goes through one transition module
([`src/transitions.js`](src/transitions.js)) that writes a `movements` row in
the same transaction. `src/db.js` is the only file that knows about SQLite —
that's the single file you swap to move to Postgres later.

## Run it

```bash
npm install
npm start        # http://localhost:3000 — auto-seeds valet.db on first run
```

(`npm run seed` exists too, to force a fresh re-seed, but `npm start` already
seeds automatically when the datastore is empty.)

- Booking site:  http://localhost:3000/booking/
- Admin console: http://localhost:3000/admin/

The admin console has a **Reset demo** button (and there's `POST /api/admin/reset`)
that wipes and re-seeds so you can re-run the flow cleanly.

## Deploying to Vercel

This repo is set up to deploy to Vercel as-is:

- [`api/index.js`](api/index.js) exports the shared Express app
  ([`src/app.js`](src/app.js)) as a serverless function.
- [`vercel.json`](vercel.json) rewrites all requests to that function; the
  `public/` frontends are served by Vercel's CDN (static files take priority
  over the rewrite), and Express handles everything else — identical to local.
- `src/server.js` (the `app.listen`) is used only for local dev.

Import the GitHub repo into Vercel (framework preset: **Other** — no build
step needed) and deploy. `npm run seed` is **not** run on Vercel; instead the
app **auto-seeds on cold start** when the datastore is empty, so the demo is
always populated.

### ⚠️ Datastore caveat on Vercel (read this)

Vercel functions have an **ephemeral, per-instance `/tmp`** filesystem and the
rest of the filesystem is read-only. So on Vercel the SQLite file lives at
`/tmp/valet.db` and:

- **Data resets on every cold start** and is **not shared** across concurrent
  function instances. Each instance re-seeds itself.
- This is fine for demoing the *flow*, but it is **not real persistence**.

This is deliberate and temporary. The spec's production path — and the next
step here — is to **migrate the data layer to Supabase Postgres**, which only
touches [`src/db.js`](src/db.js) (no schema redesign, no frontend changes).
When you're ready, set a `DATABASE_URL` env var in Vercel and swap that one
file; everything else stays put.

> Note: `better-sqlite3` is a native module. It builds on Vercel's Node 22
> runtime (pinned via `engines` in `package.json`), but if a deploy ever fails
> on the native binary, that's the cue to do the Supabase swap rather than fight
> the bundler.

## Demo script (the happy path)

1. **Booking site → Book bins:** pick a SKU mix, a delivery date, contact details → creates a booking + a `deliver_empty` job.
2. **Admin → Bookings queue:** the new booking appears with a derived bin-status summary.
3. **Admin → Assign bins:** pick the booking, scan/click bin barcodes → bins become `Assigned`.
4. **Admin → Jobs board:** mark the `deliver_empty` job **Done** → bins become `Out for filling`.
5. **Booking site → My booking:** add a contents photo to each bin → schedules a `collect_full` job.
6. **Admin → Jobs board:** mark `collect_full` **Done** → bins become `In transit (inbound)`.
7. **Admin → Warehouse scan:** put-away each bin (scan bin → scan location) → bins become `Stored`.
8. **Booking site → My booking:** request a bin back with a date → bin becomes `Retrieval requested` + a `deliver_back` job is scheduled.
9. **Admin → Warehouse scan:** scan the bin out → `In transit (outbound)`, location freed.
10. **Admin → Jobs board:** mark `deliver_back` **Done** → bin becomes `Returned to customer`.

A returned bin can then be **re-stored** (Store this again → `In transit (inbound)` → `Stored`,
skipping `Out for filling` because it's already filled) or **closed** (`Returned / closed`).
The **Bin explorer** tab shows any bin's full movement history (chain of custody).

## Data model

Six tables (see [`src/schema.sql`](src/schema.sql)): `customers`, `bins`,
`locations`, `bookings`, `jobs`, `movements`. Ids are `TEXT`, timestamps are
ISO strings — deliberately, so the schema lifts cleanly to Postgres.

Bins are the **unit of truth**. Bookings have no status state machine; the queue
summary is *derived* from the booking's bins on the fly
([`src/summary.js`](src/summary.js)).

### The seven bin statuses

`Assigned` → `Out for filling` → `In transit (inbound)` → `Stored` →
`Retrieval requested` → `In transit (outbound)` → `Returned to customer` →
(`Returned / closed`, or re-store loop back to `In transit (inbound)`).

The transition module rejects any move not in this table (try storing an
already-`Stored` bin and you get a 422).

## API surface

All under `/api`. Handlers are thin; the rules live in the transition module.

| Route | Method | Purpose |
|---|---|---|
| `/bookings` | POST | Create booking (+customer +deliver_empty job) |
| `/bookings` | GET | Admin queue (with derived summaries) |
| `/bookings/:id` | GET | Customer lookup + admin detail |
| `/bookings/by-phone/:phone` | GET | Customer lookup by phone (no login) |
| `/bookings/:id/assign-bins` | POST | Bind scanned bins → `Assigned` |
| `/jobs` | GET | Jobs board |
| `/jobs/:id/done` | POST | Advance the job's bins to their next state |
| `/bins/available` | GET | Unassigned bins (for assign screen) |
| `/bins/:barcode/photo` | POST | Attach contents-photo stub (+collect_full job) |
| `/bins/:barcode/store` | POST | Put-away: bin + location → `Stored` |
| `/bins/:barcode/scan-out` | POST | Pull from location → `In transit (outbound)` |
| `/bins/:id/request-return` | POST | Retrieval request (+deliver_back job) |
| `/bins/:id/request-restore` | POST | Re-store a returned bin (+collect_full job) |
| `/bins/:id/close` | POST | `Returned to customer` → `Returned / closed` |
| `/bins/:barcode/movements` | GET | Chain-of-custody history |
| `/locations/free` | GET | Free rack slots (for warehouse chips) |
| `/admin/reset` | POST | Wipe + re-seed |

## Deliberately deferred (not bugs)

Recorded omissions, per the spec — the build does not silently paper over them:

- **Cancellation before assignment** — no path.
- **No-show / unfilled bins** — no path.
- **Cancel a retrieval** — once `Retrieval requested` there's no path back to
  `Stored`. The transition table simply doesn't contain that move, so any
  attempt fails loudly rather than being worked around.

Also out of scope: real payments, SiteLink integration, real camera scanning,
customer login, SMS/email, route optimisation, multi-site.

## Migration note

Use of parameterised SQL and a single data-access module (`src/db.js`) means the
move to production is: swap `better-sqlite3` for a Postgres client in that one
file, add auth + row-level security, and point the same API at Supabase — no
frontend changes, no schema redesign.

`customers.sitelink_tenant_id` (seeded as `236692` on the demo customer) is the
deliberate hook for SiteLink reconciliation: unused in the single-tenant MVP,
but present so the future integration is a data-population task, not a migration.
