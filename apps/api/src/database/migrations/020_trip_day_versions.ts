import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_days add column version integer not null default 1 check (version > 0);
    create function track_changed_day(day_id uuid) returns void language plpgsql as $$
    begin
      perform set_config('along.changed_days', array(
        select distinct unnest(array_append(coalesce(nullif(current_setting('along.changed_days', true), '')::uuid[], '{}'), day_id))
      )::text, true);
    end;
    $$;
    create function version_day_window() returns trigger language plpgsql as $$
    begin
      new.version := old.version + 1;
      perform track_changed_day(new.id);
      return new;
    end;
    $$;
    create trigger trip_day_window_version before update of day_start_minute, day_end_minute on trip_days
      for each row execute function version_day_window();
    create function version_day_assignment() returns trigger language plpgsql as $$
    begin
      if tg_op <> 'INSERT' then
        update trip_days set version = version + 1 where id = old.trip_day_id;
        perform track_changed_day(old.trip_day_id);
      end if;
      if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.trip_day_id is distinct from old.trip_day_id) then
        update trip_days set version = version + 1 where id = new.trip_day_id;
        perform track_changed_day(new.trip_day_id);
      end if;
      return null;
    end;
    $$;
    create trigger trip_day_assignment_version after insert or update or delete on trip_place_day_assignments
      for each row execute function version_day_assignment();
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop trigger trip_day_assignment_version on trip_place_day_assignments;
    drop function version_day_assignment();
    drop trigger trip_day_window_version on trip_days;
    drop function version_day_window();
    drop function track_changed_day(uuid);
    alter table trip_days drop column version;
  `.execute(database);
}
