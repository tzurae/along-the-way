import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_country_stops
      add constraint trip_country_stops_trip_id_id_unique unique (trip_id, id)
  `.execute(database);

  await sql`
    create table places (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      name varchar(200) not null,
      place_type varchar(32) not null check (
        place_type in ('airport', 'station', 'lodging', 'restaurant', 'activity', 'other')
      ),
      address text,
      latitude double precision,
      longitude double precision,
      time_zone varchar(100),
      source_url text,
      notes text,
      version integer not null default 1 check (version > 0),
      created_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (trip_id, id),
      check ((latitude is null) = (longitude is null)),
      check (latitude is null or latitude between -90 and 90),
      check (longitude is null or longitude between -180 and 180)
    )
  `.execute(database);

  await sql`
    create table itinerary_items (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      item_type varchar(32) not null check (
        item_type in ('flight', 'lodging', 'transport', 'reservation', 'meal', 'activity', 'free-time')
      ),
      title varchar(200) not null,
      notes text,
      source_url text,
      amount_minor bigint,
      currency char(3),
      details jsonb not null,
      locked_at timestamptz,
      locked_by uuid references users(id),
      version integer not null default 1 check (version > 0),
      created_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (trip_id, id),
      check ((amount_minor is null) = (currency is null)),
      check (amount_minor is null or amount_minor >= 0),
      check ((locked_at is null) = (locked_by is null))
    )
  `.execute(database);

  await sql`
    create table itinerary_endpoints (
      itinerary_item_id uuid not null,
      trip_id uuid not null,
      endpoint_role varchar(10) not null check (endpoint_role in ('start', 'end')),
      country_stop_id uuid not null,
      place_id uuid not null,
      local_date_time char(16) not null check (
        local_date_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
      ),
      time_zone varchar(100) not null,
      utc_offset_minutes smallint not null check (utc_offset_minutes between -840 and 840),
      instant timestamptz not null,
      primary key (itinerary_item_id, endpoint_role),
      foreign key (trip_id, itinerary_item_id)
        references itinerary_items(trip_id, id) on delete cascade,
      foreign key (trip_id, country_stop_id)
        references trip_country_stops(trip_id, id),
      foreign key (trip_id, place_id)
        references places(trip_id, id)
    )
  `.execute(database);

  await sql`
    create index itinerary_endpoints_trip_instant
      on itinerary_endpoints (trip_id, instant)
  `.execute(database);

  await sql`
    create table itinerary_constraints (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null,
      itinerary_item_id uuid not null,
      constraint_type varchar(32) not null check (
        constraint_type in ('fixed_time', 'immovable', 'minimum_buffer')
      ),
      status varchar(16) not null check (
        status in ('confirmed', 'unknown', 'conflicted')
      ),
      minimum_buffer_minutes integer,
      version integer not null default 1 check (version > 0),
      created_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (trip_id, itinerary_item_id)
        references itinerary_items(trip_id, id) on delete cascade,
      check (
        (constraint_type = 'minimum_buffer' and minimum_buffer_minutes is not null and minimum_buffer_minutes >= 0)
        or (constraint_type <> 'minimum_buffer' and minimum_buffer_minutes is null)
      )
    )
  `.execute(database);

  await sql`
    create index itinerary_constraints_item_created
      on itinerary_constraints (trip_id, itinerary_item_id, created_at)
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await database.schema.dropTable("itinerary_constraints").ifExists().execute();
  await database.schema.dropTable("itinerary_endpoints").ifExists().execute();
  await database.schema.dropTable("itinerary_items").ifExists().execute();
  await database.schema.dropTable("places").ifExists().execute();
  await sql`
    alter table trip_country_stops
      drop constraint if exists trip_country_stops_trip_id_id_unique
  `.execute(database);
}
