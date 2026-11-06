-- 004: bookable hours, daylight and insurance rules, auto-approve, warnings on dates, calendar feeds.
begin;

-- Group-level settings
alter table tenant
  add column latitude  numeric(8,5),
  add column longitude numeric(9,5),
  add column daylight_rule  text not null default 'off' check (daylight_rule  in ('off','warn','block')),
  add column insurance_rule text not null default 'off' check (insurance_rule in ('off','warn','block'));

-- Trusted organizations are approved automatically when nothing conflicts and no rule is broken.
alter table organization add column auto_approve boolean not null default false;

-- A short note explaining why a date needs a human look (rule broken, insurance expired, ...).
alter table booking_date add column warning text;

-- Which days and hours a space (or every space, when space_id is null) can be requested.
-- Optional date range makes it a season. 'block' refuses the request; 'warn' lets staff decide.
create table space_hours (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  space_id    uuid,
  weekdays    int[] not null default '{0,1,2,3,4,5,6}',
  opens       time not null,
  closes      time not null,
  starts_on   date,
  ends_on     date,
  enforcement text not null default 'block' check (enforcement in ('warn','block')),
  note        text,
  unique (tenant_id, id),
  foreign key (tenant_id, space_id) references space (tenant_id, id),
  check (closes > opens),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

-- Insurance and permit details: a note or link, and when it runs out.
alter table compliance_document add column note text;

-- Private calendar links (an .ics feed a phone calendar can subscribe to). Only a hash of the secret is stored.
create table calendar_feed (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  user_id         uuid not null references app_user(id),
  organization_id uuid,
  label           text not null,
  token_hash      text not null unique,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, organization_id) references organization (tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['space_hours','calendar_feed'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', t);
  end loop;
end $$;

-- A calendar app has no session, so the feed URL itself is the credential. This looks it up across tenants.
create function feed_lookup(p_hash text) returns table (tenant_id uuid, organization_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, organization_id from calendar_feed where token_hash = p_hash
$$;
revoke all on function feed_lookup(text) from public;
grant execute on function feed_lookup(text) to cwui_app;

grant select, insert, update, delete on space_hours, calendar_feed to cwui_app;

insert into schema_migration (version) values ('004_rules_and_more');
commit;
