import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table change_events add column event_order bigint;
    alter table change_events add column conflict_base_version integer check (conflict_base_version > 0);
    alter table change_events add column related_target_ids uuid[] not null default '{}';
    create sequence change_event_order_seq;
    with ordered as (
      select id, row_number() over (order by created_at, id) as ordinal from change_events
    ) update change_events set event_order = ordered.ordinal from ordered where change_events.id = ordered.id;
    select setval('change_event_order_seq', coalesce((select max(event_order) from change_events), 0) + 1, false);
    create unique index change_events_order_idx on change_events(event_order);
    create index change_events_trip_order_idx on change_events(trip_id, event_order desc);
    create index change_events_target_order_idx on change_events(trip_id, target_type, target_id, event_order desc);
    create function order_change_event() returns trigger language plpgsql as $$
    begin
      -- Serialize on the same row as trip writers, before allocating the cursor.
      -- NO KEY UPDATE also permits FK KEY SHARE locks held by older writers:
      -- a separate advisory lock would invert the trip/event lock order.
      perform 1 from trips where id = new.trip_id for no key update;
      new.event_order := nextval('change_event_order_seq');
      new.conflict_base_version := nullif(current_setting('along.conflict_base_version', true), '')::integer;
      new.related_target_ids := coalesce(nullif(current_setting('along.changed_days', true), '')::uuid[], '{}')
        || coalesce(nullif(current_setting('along.related_targets', true), '')::uuid[], '{}');
      return new;
    end;
    $$;
    create trigger change_events_order before insert on change_events
      for each row execute function order_change_event();
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop trigger change_events_order on change_events;
    drop function order_change_event();
    drop index change_events_target_order_idx;
    drop index change_events_trip_order_idx;
    drop index change_events_order_idx;
    alter table change_events drop column event_order;
    alter table change_events drop column conflict_base_version;
    alter table change_events drop column related_target_ids;
    drop sequence change_event_order_seq;
  `.execute(database);
}
