import { sql, type Kysely } from "kysely";

export async function up<Database>(database: Kysely<Database>) {
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'tmc:' || place.trip_id || ':' || place.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join trip_places place on request.operation = 'tp:must:create:' || place.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'tmu:' || item.trip_id || ':' || item.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join trip_place_must_items item on request.operation = 'tp:must:update:' || item.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'tpp:' || place.trip_id || ':' || place.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join trip_places place on request.operation = 'tp:plan:' || place.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'tpa:' || day.trip_id || ':' || day.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join trip_days day on request.operation = 'tp:arrange:' || day.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'tpv:' || place.trip_id || ':' || place.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join trip_places place on request.operation = 'tp:vote:' || place.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'tps:' || suggestion.trip_id || ':' || suggestion.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join trip_place_duplicate_suggestions suggestion
      on request.operation = 'tp:separate:' || suggestion.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'tpr:' || place.trip_id || ':' || place.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join trip_places place on request.operation = 'tp:remove:' || place.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'dv:' || proposal.trip_id || ':' || proposal.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join candidate_proposals proposal on request.operation = 'discovery:vote:' || proposal.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'dr:' || proposal.trip_id || ':' || proposal.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join candidate_proposals proposal on request.operation = 'discovery:reject:' || proposal.id
    on conflict do nothing
  `.execute(database);
  await sql`
    insert into mutation_requests (actor_id, operation, idempotency_key, response, created_at)
    select request.actor_id, 'ds:' || proposal.trip_id || ':' || proposal.id,
      request.idempotency_key, request.response, request.created_at
    from mutation_requests request
    join candidate_proposals proposal on request.operation = 'discovery:restore:' || proposal.id
    on conflict do nothing
  `.execute(database);
}

async function deleteCopy<Database>(
  database: Kysely<Database>,
  newPrefix: string,
  legacyPrefix: string,
) {
  await sql`
    delete from mutation_requests copy
    using mutation_requests legacy
    where copy.operation like ${`${newPrefix}:%`}
      and legacy.actor_id = copy.actor_id
      and legacy.idempotency_key = copy.idempotency_key
      and legacy.operation = ${legacyPrefix} || split_part(copy.operation, ':', 3)
  `.execute(database);
}

export async function down<Database>(database: Kysely<Database>) {
  await deleteCopy(database, "tmc", "tp:must:create:");
  await deleteCopy(database, "tmu", "tp:must:update:");
  await deleteCopy(database, "tpp", "tp:plan:");
  await deleteCopy(database, "tpa", "tp:arrange:");
  await deleteCopy(database, "tpv", "tp:vote:");
  await deleteCopy(database, "tps", "tp:separate:");
  await deleteCopy(database, "tpr", "tp:remove:");
  await deleteCopy(database, "dv", "discovery:vote:");
  await deleteCopy(database, "dr", "discovery:reject:");
  await deleteCopy(database, "ds", "discovery:restore:");
}
