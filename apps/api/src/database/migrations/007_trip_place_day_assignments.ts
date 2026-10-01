import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    create table trip_place_day_assignments (
      trip_id uuid not null,
      trip_place_id uuid primary key,
      trip_day_id uuid not null,
      assigned_by uuid not null references users(id),
      assigned_at timestamptz not null default now(),
      foreign key (trip_id, trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, trip_day_id)
        references trip_days(trip_id, id) on delete cascade,
      foreign key (trip_id, assigned_by)
        references trip_members(trip_id, user_id) on delete cascade
    )
  `.execute(database);

  await sql`
    insert into trip_place_day_assignments (
      trip_id, trip_place_id, trip_day_id, assigned_by
    )
    select desired.trip_id, desired.trip_place_id, (array_agg(desired.trip_day_id))[1], place.created_by
    from trip_place_desired_days desired
    join trip_places place on place.id = desired.trip_place_id
    group by desired.trip_id, desired.trip_place_id, place.created_by
    having count(*) = 1
  `.execute(database);

  await sql`
    create function refresh_trip_place_day_assignment(
      affected_trip_id uuid,
      affected_trip_place_id uuid
    ) returns void
    language plpgsql
    as $$
    begin
      delete from trip_place_day_assignments
      where trip_place_id = affected_trip_place_id;

      insert into trip_place_day_assignments (
        trip_id, trip_place_id, trip_day_id, assigned_by
      )
      select
        desired.trip_id,
        desired.trip_place_id,
        (array_agg(desired.trip_day_id))[1],
        place.created_by
      from trip_place_desired_days desired
      join trip_places place on place.id = desired.trip_place_id
      where desired.trip_id = affected_trip_id
        and desired.trip_place_id = affected_trip_place_id
      group by desired.trip_id, desired.trip_place_id, place.created_by
      having count(*) = 1;
    end;
    $$
  `.execute(database);

  await sql`
    create function sync_trip_place_day_assignment()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        perform refresh_trip_place_day_assignment(old.trip_id, old.trip_place_id);
      elsif tg_op = 'INSERT' then
        perform refresh_trip_place_day_assignment(new.trip_id, new.trip_place_id);
      else
        perform refresh_trip_place_day_assignment(old.trip_id, old.trip_place_id);
        if (old.trip_id, old.trip_place_id) is distinct from (new.trip_id, new.trip_place_id) then
          perform refresh_trip_place_day_assignment(new.trip_id, new.trip_place_id);
        end if;
      end if;
      return null;
    end;
    $$
  `.execute(database);

  await sql`
    create trigger sync_trip_place_day_assignment
    after insert or update or delete on trip_place_desired_days
    for each row execute function sync_trip_place_day_assignment()
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop trigger sync_trip_place_day_assignment on trip_place_desired_days
  `.execute(database);
  await sql`drop function sync_trip_place_day_assignment()`.execute(database);
  await sql`drop function refresh_trip_place_day_assignment(uuid, uuid)`.execute(database);
  await sql`
    insert into trip_place_desired_days (trip_id, trip_place_id, trip_day_id)
    select trip_id, trip_place_id, trip_day_id
    from trip_place_day_assignments
    on conflict (trip_place_id, trip_day_id) do nothing
  `.execute(database);
  await sql`drop table trip_place_day_assignments`.execute(database);
}
