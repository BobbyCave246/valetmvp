# ADR-0001: Staff surface split

## Status

Accepted

## Context

The MVP launched as a single combined admin/warehouse console at `/admin/`, gated
by a shared `ADMIN_TOKEN` bearer. Field staff and back-office ops shared one UI
and one credential, which was adequate for demos but blurred role boundaries.

## Decision

Split staff work into three role-specific surfaces after unified session auth:

| Role | Surface | Responsibility |
|------|---------|------------------|
| `admin` | `/admin/` | Supervisor console: queue, assign, customers, dispatch, explorer, inventory view, staff provisioning |
| `warehouse` | `/warehouse/` | Phone-first scan station: put-away, pull-out, bin intake |
| `driver` | `/driver/` | Phone-first jobs board with scan-to-confirm checklist |

All staff sign in at `/login/` and are redirected to their surface. The API
remains a single backend with `requireRole` guards. Admin deep-links into field
apps for warehouse and driver execution rather than duplicating those flows.

The old `/start` role launcher and `ADMIN_TOKEN` bearer gate were removed.

## Consequences

- Warehouse and driver apps own field execution UX (scan-gun reset, maps, checklist).
- Admin is slimmer (~35% less client code) and orchestrates rather than duplicates.
- Shared client modules live in `public/shared/` (`client.js`, `labels.js`, `modal.js`, `field-links.js`).
- Admin retains break-glass "mark done" override behind an explicit confirm dialog.
- Read-only rack map and inventory summary remain in admin for supervisor visibility.

## Alternatives considered

**Keep combined admin console** — rejected after split because it maintained
duplicate warehouse tabs and job completion, undermining the purpose of dedicated
field apps.

**Separate backends per role** — rejected; role-gated routes on one API are simpler
and match the MVP scale.
