import { sql, type Kysely } from "kysely";

// Expand-only: older releases ignore generated guide rows.
export async function up(database: Kysely<unknown>) {
  await sql`
    create function place_guide_item_array_valid(value jsonb)
    returns boolean
    language sql
    immutable
    parallel safe
    return case
      when jsonb_typeof(value) <> 'array' then false
      when jsonb_array_length(value) > 3 then false
      else not exists (
        select 1
        from jsonb_array_elements(value) item
        where jsonb_typeof(item) <> 'string'
          or length(item #>> '{}') > 120
          or length(trim(item #>> '{}')) = 0
      )
    end;

    create function place_guide_sources_valid(value jsonb)
    returns boolean
    language sql
    immutable
    parallel safe
    return case
      when jsonb_typeof(value) <> 'array' then false
      when jsonb_array_length(value) > 12 then false
      else not exists (
        select 1
        from jsonb_array_elements(value) source
        where jsonb_typeof(source) <> 'object'
          or not source ? 'title'
          or not source ? 'url'
          or source - 'title' - 'url' <> '{}'::jsonb
          or jsonb_typeof(source->'title') <> 'string'
          or length(trim(source->>'title')) = 0
          or length(source->>'title') > 500
          or jsonb_typeof(source->'url') <> 'string'
          or source->>'url' !~* '^https://([a-z0-9-]+\\.)+(wikipedia|wikivoyage)\\.org/'
      )
    end;

    create table place_guides (
      place_id uuid primary key references place_identities(id) on delete cascade,
      language varchar(35) not null default 'zh-TW'
        check (length(trim(language)) > 0),
      history text check (history is null or length(history) <= 2000),
      see jsonb not null default '[]'::jsonb
        check (place_guide_item_array_valid(see)),
      "do" jsonb not null default '[]'::jsonb
        check (place_guide_item_array_valid("do")),
      eat jsonb not null default '[]'::jsonb
        check (place_guide_item_array_valid(eat)),
      sources jsonb not null default '[]'::jsonb
        check (place_guide_sources_valid(sources)),
      model text,
      status varchar(20) not null
        check (status in ('generating', 'ready', 'no_sources', 'failed')),
      claim_token uuid,
      claimed_at timestamptz,
      generated_at timestamptz not null default now(),
      check (status <> 'ready' or (jsonb_array_length(sources) > 0 and model is not null)),
      check (
        (status = 'generating' and claim_token is not null and claimed_at is not null)
        or (status <> 'generating' and claim_token is null and claimed_at is null)
      )
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop table place_guides;
    drop function place_guide_sources_valid(jsonb);
    drop function place_guide_item_array_valid(jsonb);
  `.execute(database);
}
