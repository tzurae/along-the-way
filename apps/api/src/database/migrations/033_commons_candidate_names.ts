import { sql, type Kysely } from "kysely";

// Additive facts let later releases rank existing candidates without rewriting them.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table commons_photo_candidates
      add column names jsonb not null default '[]'::jsonb
        check (jsonb_typeof(names) = 'array'),
      add column instance_of jsonb not null default '[]'::jsonb
        check (jsonb_typeof(instance_of) = 'array'),
      add column auto_applied boolean not null default false;

    alter table commons_photo_candidates
      drop constraint commons_photo_candidates_check,
      add constraint commons_photo_candidates_decision_check check (
        (status = 'pending' and decided_by_user_id is null and decided_at is null and not auto_applied)
        or (
          status = 'confirmed'
          and decided_at is not null
          and (
            (auto_applied and decided_by_user_id is null)
            or (not auto_applied and decided_by_user_id is not null)
          )
        )
        or (status = 'rejected' and decided_at is not null and not auto_applied)
      );
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    alter table commons_photo_candidates
      drop constraint commons_photo_candidates_decision_check,
      drop column auto_applied,
      drop column instance_of,
      drop column names,
      add constraint commons_photo_candidates_check check (
        (status = 'pending' and decided_by_user_id is null and decided_at is null)
        or (status <> 'pending' and decided_by_user_id is not null and decided_at is not null)
      );
  `.execute(database);
}
