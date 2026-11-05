-- 001_init.sql  (run as cwui_owner against each database)
begin;

create extension if not exists btree_gist;

-- ---------------------------------------------------------------- helpers
-- Every request sets:  select set_config('app.tenant_id', '<uuid>', true);  inside its transaction.
-- If it is not set, current_tenant() is NULL and every tenant policy returns no rows (fail closed).
create function current_tenant() returns uuid
language sql stable as
$$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- platform tables
create table plan (
  code                   text primary key,
  name                   text not null,
  included_fields        int  not null,
  base_price_cents       int  not null,
  extra_field_price_cents int not null
);
insert into plan values ('starter', 'Starter', 3, 4900, 1000);

create table tenant (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  plan_code   text not null references plan(code) default 'starter',
  timezone    text not null default 'America/New_York',
  status      text not null default 'active' check (status in ('active','suspended','closed')),
  created_at  timestamptz not null default now()
);

-- Users are platform-level (one login can hold roles in several tenants).
create table app_user (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  full_name   text not null,
  created_at  timestamptz not null default now()
);
create unique index app_user_email_key on app_user (lower(email));

-- ---------------------------------------------------------------- tenant-scoped tables
create table organization (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  kind        text not null default 'club' check (kind in ('club','school','league','other')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table role_assignment (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  user_id         uuid not null references app_user(id),
  organization_id uuid,
  role            text not null check (role in ('tenant_admin','approver','org_admin','booker','viewer')),
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, organization_id) references organization (tenant_id, id),
  check (
    (role in ('tenant_admin','approver') and organization_id is null) or
    (role in ('org_admin','booker')      and organization_id is not null) or
    (role = 'viewer')
  )
);
create unique index role_assignment_unique
  on role_assignment (tenant_id, user_id, role, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'));

create table user_priority (
  tenant_id   uuid not null references tenant(id),
  user_id     uuid not null references app_user(id),
  level       int  not null check (level between 1 and 5),   -- higher wins
  primary key (tenant_id, user_id)
);

create table facility (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  address     text,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table space (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  facility_id    uuid not null,
  parent_id      uuid,
  name           text not null,
  kind           text not null default 'field' check (kind in ('field','room','court','other')),
  buffer_minutes int  not null default 0 check (buffer_minutes between 0 and 240),
  active         boolean not null default true,
  unique (tenant_id, id),
  foreign key (tenant_id, facility_id) references facility (tenant_id, id),
  foreign key (tenant_id, parent_id)   references space (tenant_id, id),
  check (parent_id is distinct from id)
);

-- Composite layouts: "Layout X (9v9)" is made of Field 1B and Field 2A.
-- Booking the composite uses its components; booking a component makes the composite unavailable.
create table space_link (
  tenant_id     uuid not null references tenant(id),
  composite_id  uuid not null,
  component_id  uuid not null,
  primary key (tenant_id, composite_id, component_id),
  foreign key (tenant_id, composite_id) references space (tenant_id, id),
  foreign key (tenant_id, component_id) references space (tenant_id, id),
  check (composite_id <> component_id)
);

create table request (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  organization_id   uuid not null,
  requested_by      uuid not null references app_user(id),
  space_id          uuid not null,
  title             text not null,
  notes             text,
  status            text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
  priority_snapshot int  not null default 1,
  recurrence_rule   text,
  submitted_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, organization_id) references organization (tenant_id, id),
  foreign key (tenant_id, space_id)        references space (tenant_id, id)
);

create table booking_date (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  request_id  uuid not null,
  space_id    uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  status      text not null default 'pending' check (status in ('pending','confirmed','cancelled','flagged')),
  unique (tenant_id, id),
  foreign key (tenant_id, request_id) references request (tenant_id, id),
  foreign key (tenant_id, space_id)   references space (tenant_id, id),
  check (ends_at > starts_at)
);
create index booking_date_space_time on booking_date (tenant_id, space_id, starts_at);

create table blackout (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  space_id    uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text not null,
  unique (tenant_id, id),
  foreign key (tenant_id, space_id) references space (tenant_id, id),
  check (ends_at > starts_at)
);

-- One row per space made unavailable. The exclusion constraint is the final safety net:
-- even with two approvers clicking at once, the database refuses an overlap.
create table blocked_slot (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  space_id        uuid not null,
  during          tstzrange not null,
  is_claim        boolean not null,   -- true: the space itself or a sub-space is in use; false: only part of it is (a parent of a booked sub-space)
  booking_date_id uuid,
  blackout_id     uuid,
  foreign key (tenant_id, space_id)        references space (tenant_id, id),
  foreign key (tenant_id, booking_date_id) references booking_date (tenant_id, id) on delete cascade,
  foreign key (tenant_id, blackout_id)     references blackout (tenant_id, id)     on delete cascade,
  check ((booking_date_id is not null)::int + (blackout_id is not null)::int = 1),
  -- claim vs claim: two uses of the same space (or a space and its sub-spaces) can never overlap
  constraint no_double_booking exclude using gist (space_id with =, during with &&) where (is_claim),
  -- claim vs partial: a whole field can't be used while one of its halves is booked.
  -- partial vs partial is allowed: Field 1A and Field 1B can both be booked at once.
  constraint no_claim_over_partial exclude using gist (space_id with =, during with &&, is_claim with <>)
);

create table compliance_document (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  organization_id uuid not null,
  kind            text not null check (kind in ('insurance','permit','waiver','other')),
  expires_on      date,
  file_ref        text,
  foreign key (tenant_id, organization_id) references organization (tenant_id, id)
);

create table approval (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  request_id  uuid not null,
  decided_by  uuid not null references app_user(id),
  decision    text not null check (decision in ('approved','declined','returned')),
  note        text,
  decided_at  timestamptz not null default now(),
  foreign key (tenant_id, request_id) references request (tenant_id, id)
);

create table notification (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  user_id     uuid not null references app_user(id),
  kind        text not null,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create table audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenant(id),
  actor_id    uuid references app_user(id),
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  detail      jsonb not null default '{}',
  at          timestamptz not null default now()
);

-- ---------------------------------------------------------------- functions
-- A space and everything beneath it.
create function space_descendants(p_space uuid) returns setof uuid
language sql stable as $$
  with recursive down(id) as (
    select id from space where id = p_space
    union all
    select s.id from space s join down on s.parent_id = down.id
  ) select id from down
$$;

-- Everything above a space (not including the space).
create function space_ancestors(p_space uuid) returns setof uuid
language sql stable as $$
  with recursive up(id, parent_id) as (
    select id, parent_id from space where id = p_space
    union all
    select s.id, s.parent_id from space s join up on s.id = up.parent_id
  ) select id from up where id <> p_space
$$;

-- What using p_space does to the map.
--   claimed: the space, everything beneath it, and (for a composite layout) its components
--   partial: parents of anything claimed, and composite layouts that contain anything claimed
create function affected_spaces(p_space uuid) returns table (space_id uuid, is_claim boolean)
language sql stable as $$
  with roots as (
    select p_space as id
    union
    select component_id from space_link where composite_id = p_space
  ), claims as (
    select distinct d as id from roots r, lateral space_descendants(r.id) d
  ), comps as (
    select distinct composite_id as id from space_link where component_id in (select id from claims)
  ), partials as (
    select id from comps
    union
    select distinct a from (select id from claims union select id from comps) c, lateral space_ancestors(c.id) a
  )
  select id, true from claims
  union all
  select id, false from partials where id not in (select id from claims)
$$;

-- Approve one date: confirm it and write a blocked_slot per affected space.
-- The space's buffer_minutes is added after the end (turnover time before the next booking).
-- Raises exclusion_violation (23P01) if anything overlaps, rolling the whole call back.
create function approve_booking_date(p_booking_date uuid) returns void
language plpgsql as $$
declare
  b booking_date%rowtype;
  buf int;
begin
  select * into b from booking_date where id = p_booking_date for update;
  if not found then raise exception 'booking_date not found'; end if;
  if b.status = 'confirmed' then return; end if;
  select buffer_minutes into buf from space where id = b.space_id;
  insert into blocked_slot (tenant_id, space_id, is_claim, during, booking_date_id)
  select b.tenant_id, a.space_id, a.is_claim,
         tstzrange(b.starts_at, b.ends_at + buf * interval '1 minute', '[)'), b.id
  from affected_spaces(b.space_id) a;
  update booking_date set status = 'confirmed' where id = b.id;
end $$;

create function cancel_booking_date(p_booking_date uuid) returns void
language plpgsql as $$
begin
  delete from blocked_slot where booking_date_id = p_booking_date;
  update booking_date set status = 'cancelled' where id = p_booking_date;
end $$;

-- A blackout is treated like a booking of the space (blocks it, its sub-spaces, and marks its parents partial).
create function create_blackout(p_space uuid, p_from timestamptz, p_to timestamptz, p_reason text)
returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_tenant uuid := current_tenant();
begin
  insert into blackout (tenant_id, space_id, starts_at, ends_at, reason)
  values (v_tenant, p_space, p_from, p_to, p_reason) returning id into v_id;
  insert into blocked_slot (tenant_id, space_id, is_claim, during, blackout_id)
  select v_tenant, a.space_id, a.is_claim, tstzrange(p_from, p_to, '[)'), v_id from affected_spaces(p_space) a;
  return v_id;
end $$;

-- Sign-in helper: which tenants does this user belong to? (sees across tenants, hence SECURITY DEFINER)
create function user_tenants(p_user uuid) returns table (tenant_id uuid, role text, organization_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, role, organization_id from role_assignment where user_id = p_user
$$;
revoke all on function user_tenants(uuid) from public;

-- ---------------------------------------------------------------- row-level security
do $$
declare t text;
begin
  foreach t in array array['organization','role_assignment','user_priority','facility','space','space_link',
    'request','booking_date','blackout','blocked_slot','compliance_document','approval','notification','audit_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', t);
  end loop;
end $$;

alter table tenant enable row level security;
create policy tenant_self on tenant using (id = current_tenant()) with check (id = current_tenant());

-- ---------------------------------------------------------------- app privileges
grant execute on function current_tenant(), space_descendants(uuid), space_ancestors(uuid), affected_spaces(uuid),
  approve_booking_date(uuid), cancel_booking_date(uuid),
  create_blackout(uuid, timestamptz, timestamptz, text), user_tenants(uuid) to cwui_app;

grant select, insert, update, delete on all tables in schema public to cwui_app;
grant usage, select on all sequences in schema public to cwui_app;
revoke update, delete on audit_log from cwui_app;
revoke insert, update, delete on plan from cwui_app;
alter default privileges in schema public grant select, insert, update, delete on tables to cwui_app;
alter default privileges in schema public grant usage, select on sequences to cwui_app;

create table schema_migration (version text primary key, applied_at timestamptz not null default now());
insert into schema_migration (version) values ('001_init');

commit;
