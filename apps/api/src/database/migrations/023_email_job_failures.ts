import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table email_jobs
      add column failed_at timestamptz
  `.execute(database);
  await sql`
    create index active_email_jobs
      on email_jobs (available_at, created_at, id)
      where delivered_at is null and failed_at is null
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop index active_email_jobs`.execute(database);
  await sql`
    alter table email_jobs
      drop column failed_at
  `.execute(database);
}
