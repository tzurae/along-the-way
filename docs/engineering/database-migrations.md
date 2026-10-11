# Database migration policy

Deployments can move application code backward quickly, but production data is
not automatically migrated backward. Every migration must therefore use an
expand/contract sequence:

1. **Expand:** add nullable columns, new tables, indexes, or compatibility views.
   Existing code must continue to work unchanged.
2. **Migrate usage:** deploy code that can read both shapes, backfill if needed,
   then deploy code that no longer needs the old shape.
3. **Contract later:** remove old columns or constraints only after at least one
   full release has run without the old dependency and rollback no longer targets
   code that needs it.

Never combine a destructive schema change with the first release that stops
using the old schema. Seed changes remain idempotent upserts.

The deployment script runs migrations only while moving forward, then starts and
checks the new release. If activation fails, it bypasses the older migrator and
starts the previous release's retained image with its own versioned environment.
That release's `/ready` check must pass against the forward-compatible schema.
Manual rollback performs the same migration-free check before swapping release
pointers. CI records a synthetic future migration to verify this rollback path.
