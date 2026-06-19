# Store All Valet — MVP

A local-first prototype that simulates the full valet-bin lifecycle: a customer
books storage → we deliver empty bins → they're filled → collected → racked in
the warehouse → retrieved on demand → returned or closed. Built to validate the
**flow and the data model**, not for production (no payments, and camera
scanning is best-effort). Staff sign in with role-based access (see
[Sign-in & roles](#sign-in--roles)); customers book without an account.

## Stack

- **Datastore:** Postgres (Supabase) via [`postgres`](https://github.com/porsager/postgres) (postgres.js)
- **Backend:** Node + Express (plain JS / ESM, fully async data layer)
- **Frontends:** two vanilla HTML/JS/CSS apps served by Express
  - Public booking site → `/booking/`
  - Combined admin / warehouse console → `/admin/`

**Architectural rule:** the frontend never touches the DB. All reads/writes go
through `/api`, and *every* bin-status change goes through one transition module
([`src/transitions.js`](src/transitions.js)) that writes a `movements` row in
the **same Postgres transaction** (via `sql.begin`). `src/db.js` is the only
file that knows about the database driver.

## Configure the database

The app needs a `DATABASE_URL` pointing at a Postgres database. With Supabase:

1. Create (or open) a Supabase project dedicated to this app.
2. **Project → Settings → Database → Connection string → "Transaction pooler"**
   (URI form). The transaction pooler is the right one for serverless/Vercel.
3. Put it in `.env` for local dev (copy [`.env.example`](.env.example)):
   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
4. On Vercel, set `DATABASE_URL` as a Project Environment Variable.

The schema is **created automatically** on first boot (idempotent
`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`), and the demo data is
**auto-seeded** when the tables are empty — no manual migration step.

## Booking configuration (env)

The booking flow has a serviceability gate and delivery time-windows, configured
via env vars (sensible defaults ship for the demo):

| Var | Default | Purpose |
|---|---|---|
| `COVERAGE_AREAS` | The Villages at Coverley | Comma-separated list of the areas you serve (the booking dropdown). The MVP is limited to The Villages at Coverley (Christ Church, Barbados); set this to expand coverage. Out-of-area visitors join an email waitlist instead of booking. |
| `SLOT_CAPACITY` | `4` | Max empty-bin deliveries per window per day (so routes can be batched). |
| `LEAD_DAYS` | `1` | Minimum lead time — earliest bookable delivery date (default = tomorrow). |

Windows are Morning (8am–12pm) / Afternoon (12–5pm), served to both frontends
via `GET /api/serviceability` so labels have a single source of truth.

## Sign-in & roles

Staff sign in at **`/login`**; customers never log in (they book and look up by
phone/booking reference as before). There are three staff roles, and a person
only ever sees their own surface:

| Role | Surface | Can do |
|---|---|---|
| `driver` | `/driver` | the jobs board (`/api/jobs`) |
| `warehouse` | `/warehouse` | put-away, pull-out, bin intake, rack/locations |
| `admin` | `/admin` | bookings queue, assign, cancel, stats, reports, demo reset, **staff management** (create, deactivate, reactivate) |

Sessions are a signed httpOnly cookie (Node `crypto` only — no auth deps). The
**API is the security boundary**: every protected `/api` route checks the
role server-side, so the static HTML shells being public is harmless (an
unauthorised visitor just gets 401/403 on every call). After login the client
redirects each role to its surface and bounces anyone who lands on the wrong one.

Accounts are **admin-provisioned** — roles are never self-selected. An admin
creates staff in the admin console's **Staff** tab and can **deactivate** or
**reactivate** accounts without deleting them (inactive staff cannot sign in).
Starter accounts are seeded on first boot (idempotent; they survive `POST /api/admin/reset`).

| Var | Default | Purpose |
|---|---|---|
| `AUTH_SECRET` | **required** | Signs session cookies. Generate with `openssl rand -base64 32`. Rotating it logs everyone out. |
| `SESSION_TTL_SECONDS` | `43200` (12h) | Session/cookie lifetime. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `admin@valet.local` / `admin1234` | Starter admin. **Change the password immediately.** |
| `SEED_DRIVER_*`, `SEED_WAREHOUSE_*` | `driver@valet.local` / `warehouse@valet.local` (…`1234`) | Starter driver & warehouse accounts. |

> Set `AUTH_SECRET` (and ideally non-default seed credentials) on Vercel and
> **redeploy** — env changes only take effect on a new deployment.
>
> The old `ADMIN_TOKEN` bearer gate has been **removed**; `POST /api/admin/reset`
> and `POST /api/bookings/:id/cancel` now require an admin session instead.

> **Timezone note:** all date math (lead time, "today") runs on the **UTC**
> calendar. For timezones west of UTC, the earliest bookable day can appear one
> day later in the late evening local time — acceptable for the MVP.

## Run it

```bash
npm install
# put your DATABASE_URL in .env (see above)
npm start        # http://localhost:3000 — creates schema + seeds on first run
```

(`npm run seed` forces a fresh re-seed; `npm start` already seeds automatically
when the database is empty.)

- Booking site:  http://localhost:3000/booking/
- Admin console: http://localhost:3000/admin/

The admin console has a **Reset demo** button (and there's `POST /api/admin/reset`)
that wipes and re-seeds so you can re-run the flow cleanly.

## Deploying to Vercel

This repo deploys to Vercel as-is:

- [`api/index.js`](api/index.js) exports the shared Express app
  ([`src/app.js`](src/app.js)) as a serverless function.
- [`vercel.json`](vercel.json) rewrites all requests to that function; the
  `public/` frontends are served by Vercel's CDN (static files take priority
  over the rewrite), and Express handles everything else — identical to local.
- `src/server.js` (the `app.listen`) is used only for local dev.

Steps: import the GitHub repo into Vercel (framework preset: **Other** — no
build step), set the **`DATABASE_URL`** env var to your Supabase transaction
pooler string, and deploy. Because the datastore is now shared Postgres,
state persists across requests and serverless instances (this is what fixed the
old "data disappears" behaviour from the ephemeral per-instance SQLite).

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

Six tables (created by the DDL in [`src/db.js`](src/db.js)): `customers`,
`bins`, `locations`, `bookings`, `jobs`, `movements`. Ids are `TEXT`,
timestamps are ISO strings.

Bins are the **unit of truth**. Bookings have no status state machine; the queue
summary is *derived* from the booking's bins on the fly
([`src/summary.js`](src/summary.js)).

### The seven bin statuses

`Assigned` → `Out for filling` → `In transit (inbound)` → `Stored` →
`Retrieval requested` → `In transit (outbound)` → `Returned to customer` →
(`Returned / closed`, or re-store loop back to `In transit (inbound)`).

Closing a bin **releases it back to inventory**: its booking/customer/photo
fields are cleared and it becomes assignable to a new booking
(`Returned / closed → Assigned`), with the movements log preserving the full
chain of custody across lifecycles.

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
| `/bins/:barcode/photo` | POST | Upload contents photo to Supabase Storage (Out for filling only) |
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

## Notes

The data layer is isolated in a single async module (`src/db.js`) using
parameterised SQL throughout. Production hardening from here would add auth +
row-level security; the API and frontends stay unchanged.

`customers.sitelink_tenant_id` (seeded as `236692` on the demo customer) is the
deliberate hook for SiteLink reconciliation: unused in the single-tenant MVP,
but present so the future integration is a data-population task, not a migration.
