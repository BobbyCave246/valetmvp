# Admin Roadmap — GitHub Issues Index

Published from the deferred admin-console plan. Each issue body includes `**Triage:** ready-for-agent`.

## Admin console improvements

**PRD:** [#40](https://github.com/BobbyCave246/valetmvp/issues/40) — Staff lifecycle, reporting, and theme unification

| Issue | Title | Blocked by |
|-------|-------|------------|
| [#41](https://github.com/BobbyCave246/valetmvp/issues/41) | Staff deactivate / reactivate | — |
| [#42](https://github.com/BobbyCave246/valetmvp/issues/42) | Shared staff theme + admin token fixes | — |
| [#43](https://github.com/BobbyCave246/valetmvp/issues/43) | Admin Reports tab (summary + exports) | #42 (soft) |

## Notes

- Suggested pick-up order: #41 → #42 → #43.
- Staff deactivate uses soft `is_active` (accounts preserved across demo reset).
- Theme unification keeps admin on a dark palette with shared component structure; booking brand stays separate.
- Reports tab uses `scheduled_date` for job range filtering until a `completed_at` column exists.
