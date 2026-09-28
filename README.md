# Along the Way

Along the Way helps people shape a trip together: what matters now, what still
needs a decision, and how to keep the plan comfortable in real life.

This repository currently contains two deliberately separate surfaces:

- The original static Hong Kong itinerary at the repository root. GitHub Pages
  can keep serving it without a build step.
- The new full-stack foundation under `apps/`, backed by PostgreSQL/PostGIS and
  exposed through Caddy.

## Run the full stack

```sh
cp .env.example .env
# Replace both database passwords, set TOKEN_SECRET, and set BOOTSTRAP_OWNER_EMAIL.
docker compose up --detach --build --wait
```

Open `http://localhost`, request a sign-in link for the configured Owner, then
open the captured message at `http://localhost:8025`. A PostgreSQL-backed worker
delivers queued authentication and invitation email. The same magic-link,
session, Trip, membership, and invitation path is used outside local
development; Mailpit replaces only the SMTP destination.

Useful checks:

```sh
curl http://localhost/health
curl http://localhost/ready
curl http://localhost/api/trips # returns unauthenticated until signed in
```

Development verification:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

Staging setup, HTTPS deployment, persistent data, and rollback are documented in
[`docs/operations/staging.md`](docs/operations/staging.md).

The existing static site remains available at
<https://tzurae.github.io/along-the-way/>.
