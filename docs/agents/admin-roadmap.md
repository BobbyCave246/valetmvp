# Admin production roadmap

Prioritized follow-ups for the admin supervisor console beyond the MVP slim-down.
See also [phase-roadmap.md](./phase-roadmap.md) for cross-cutting customer/staff work.

## Implemented in admin slim-down

- Customers tab (search by name, phone, email; bookings per customer)
- Dispatch tab (today/upcoming jobs grouped by delivery window; links to driver app)
- Inventory tab (bin counts by status/SKU, low-pool alerts on assign, read-only rack map)
- Hash routing for bookmarkable tabs (`#assign?booking=…`, `#explorer?barcode=…`)
- Deep links to warehouse and driver apps from queue next-actions
- Shared client modules in `public/shared/`

## Phase 1 — Ops reality (GitHub #20–#26)

| Priority | Item | Admin impact |
|----------|------|--------------|
| P0 | Barbados timezone (#21) | Delivery dates and dispatch "Today" must use local calendar |
| P0 | Email notifications (#25) | Optional admin notification log tab |
| P1 | SMS notifications (#26) | Same as email; depends on #25 |

## Phase 2 — Staff efficiency (#27–#30)

| Priority | Item | Admin impact |
|----------|------|--------------|
| P1 | Atomic assign bins (#30) | Assign tab error handling; fewer partial states |
| P2 | Driver maps (#29) | Dispatch cards could embed map links (driver app already has Navigate) |

## Phase 3 — Trust and scale (#31–#32)

| Priority | Item | Admin impact |
|----------|------|--------------|
| P1 | Real contents photo storage (#32) | Bin explorer already displays photos; verify Supabase URLs in prod |

## Admin-specific backlog (not yet filed)

| Priority | Item | Notes |
|----------|------|-------|
| P1 | Staff lifecycle | Deactivate accounts, role change, password reset (API + UI) |
| P1 | Capacity dashboard | Visual slot fill per delivery window; override for ops |
| P2 | Global ops audit log | "Who did what today" across movements, not just per-bin explorer |
| P2 | Exception queue | Stuck bookings (e.g. Out for filling > N days) |
| P2 | Reporting exports | Bookings, occupancy trend, jobs completed |
| P3 | Payments (#33) | Stripe for deliver-back fee when account ready |
| P3 | SiteLink integration | Populate `sitelink_tenant_id`; reconciliation UI |
| P3 | Configurable service area | Admin-editable coverage without redeploy |

## Technical hardening

- HTTP integration tests for `requireRole` on admin-only routes (`test/auth-middleware.test.js`)
- Consider removing admin access to `POST /jobs/:id/done` if break-glass override is retired
