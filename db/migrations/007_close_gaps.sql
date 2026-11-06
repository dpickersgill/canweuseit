-- 007: self-serve plans and sign-up, online payments, field outlines on a map, teams inside a club's time,
-- partial release and no-shows, use-it-or-lose-it rules, text alerts.
begin;

-- ------------------------------------------------------------ plans and self-serve sign-up
alter table plan add column max_facilities int;          -- null = no limit
alter table plan add column online_payments boolean not null default false;
insert into plan (code, name, included_fields, base_price_cents, extra_field_price_cents, max_facilities, online_payments) values
  ('free', 'Free', 3, 0, 0, 1, false),
  ('standard', 'Standard', 20, 14900, 0, 3, true),
  ('pro', 'Pro', 200, 34900, 0, null, true);
update plan set max_facilities = null, online_payments = true where code = 'starter'; -- existing tenants keep everything

create table signup_attempt (
  id     bigserial primary key,
  email  text not null,
  ip     text,
  at     timestamptz not null default now()
);
revoke all on signup_attempt from cwui_app;

-- Anyone can start a governing group. Returns the new tenant id; the caller emails a sign-in link.
create function signup_tenant(p_name text, p_slug text, p_timezone text, p_email text, p_full_name text, p_ip text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_user uuid;
begin
  if (select count(*) from signup_attempt where lower(email) = lower(p_email) and at > now() - interval '1 day') >= 3
     or (p_ip is not null and (select count(*) from signup_attempt where ip = p_ip and at > now() - interval '1 day') >= 10)
     or (select count(*) from signup_attempt where at > now() - interval '1 day') >= 300 then
    raise exception 'too many sign-ups' using errcode = 'P0001';
  end if;
  insert into signup_attempt (email, ip) values (left(p_email, 254), left(p_ip, 64));
  insert into tenant (name, slug, plan_code, timezone) values (left(p_name, 120), p_slug, 'free', p_timezone) returning id into v_tenant;
  select id into v_user from app_user where lower(email) = lower(p_email);
  if v_user is null then
    insert into app_user (email, full_name) values (left(p_email, 254), left(p_full_name, 120)) returning id into v_user;
  end if;
  insert into role_assignment (tenant_id, user_id, role) values (v_tenant, v_user, 'tenant_admin');
  return v_tenant;
end $$;
revoke all on function signup_tenant(text, text, text, text, text, text) from public;
grant execute on function signup_tenant(text, text, text, text, text, text) to cwui_app;

-- Names of the tenants a user belongs to, for the switcher (crosses tenants, so definer).
create function user_tenant_names(p_user uuid) returns table (id uuid, name text, slug text)
language sql stable security definer set search_path = public as $$
  select distinct t.id, t.name, t.slug from role_assignment ra join tenant t on t.id = ra.tenant_id
   where ra.user_id = p_user and t.status = 'active' order by t.name
$$;
revoke all on function user_tenant_names(uuid) from public;
grant execute on function user_tenant_names(uuid) to cwui_app;

-- ------------------------------------------------------------ online payments (Stripe Connect)
alter table tenant
  add column stripe_account_id text,
  add column payments_ready boolean not null default false,
  add column deposit_cents int not null default 0 check (deposit_cents between 0 and 10000000),
  add column platform_fee_bps int not null default 100 check (platform_fee_bps between 0 and 1000);

alter table invoice drop constraint invoice_status_check;
alter table invoice add constraint invoice_status_check check (status in ('open','paid','void','refunded'));
alter table invoice
  add column kind text not null default 'fee' check (kind in ('fee','deposit')),
  add column refunded_cents int not null default 0 check (refunded_cents >= 0),
  add column checkout_id text,
  add column payment_intent text;

-- The payment webhook does not know the tenant; this marks one invoice paid if the checkout matches.
create function invoice_paid_online(p_invoice uuid, p_checkout text, p_intent text, p_amount int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  update invoice set status = 'paid', paid_at = now(), paid_method = 'card', paid_ref = p_intent, payment_intent = p_intent
   where id = p_invoice and checkout_id = p_checkout and status = 'open' and amount_cents = p_amount
   returning tenant_id into v_tenant;
  return v_tenant;
end $$;
revoke all on function invoice_paid_online(uuid, text, text, int) from public;
grant execute on function invoice_paid_online(uuid, text, text, int) to cwui_app;

create function tenant_payments_ready(p_account text, p_ready boolean) returns void
language sql security definer set search_path = public as $$
  update tenant set payments_ready = p_ready where stripe_account_id = p_account
$$;
revoke all on function tenant_payments_ready(text, boolean) from public;
grant execute on function tenant_payments_ready(text, boolean) to cwui_app;

-- ------------------------------------------------------------ fields on a map
alter table space add column outline jsonb;   -- [[lng, lat], ...] ring, first point not repeated
alter table facility add column latitude numeric(9,6), add column longitude numeric(9,6);

-- ------------------------------------------------------------ teams inside a club's time
create table team (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  organization_id uuid not null,
  name            text not null,
  coach_user_id   uuid references app_user(id),
  active          boolean not null default true,
  unique (tenant_id, id),
  foreign key (tenant_id, organization_id) references organization (tenant_id, id)
);
create unique index team_name_key on team (tenant_id, organization_id, lower(name)) where active;

create table team_slot (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  booking_date_id uuid not null,
  team_id         uuid not null,
  space_id        uuid not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  unique (tenant_id, id),
  foreign key (tenant_id, booking_date_id) references booking_date (tenant_id, id) on delete cascade,
  foreign key (tenant_id, team_id) references team (tenant_id, id),
  foreign key (tenant_id, space_id) references space (tenant_id, id),
  check (ends_at > starts_at)
);
create index team_slot_date on team_slot (booking_date_id);

-- ------------------------------------------------------------ partial release, no-shows, use-it-or-lose-it
alter table booking_date
  add column no_show boolean not null default false,
  add column released_minutes int not null default 0 check (released_minutes >= 0);
alter table tenant
  add column min_use_pct int check (min_use_pct between 1 and 100),
  add column no_show_limit int check (no_show_limit between 1 and 50);

-- Shrink a confirmed date to [p_from, p_to), giving the rest back. Team slots must already fit inside.
create function trim_booking_date(p_booking_date uuid, p_from timestamptz, p_to timestamptz) returns void
language plpgsql as $$
declare b booking_date%rowtype; buf int;
begin
  select * into b from booking_date where id = p_booking_date for update;
  if not found then raise exception 'booking_date not found'; end if;
  if b.status <> 'confirmed' then raise exception 'only confirmed dates can be trimmed' using errcode = 'P0001'; end if;
  if p_from < b.starts_at or p_to > b.ends_at or p_to <= p_from then raise exception 'new time must sit inside the old one' using errcode = 'P0001'; end if;
  if exists (select 1 from team_slot where booking_date_id = b.id and (starts_at < p_from or ends_at > p_to)) then
    raise exception 'move or remove team times outside the new window first' using errcode = 'P0001';
  end if;
  select buffer_minutes into buf from space where id = b.space_id;
  delete from blocked_slot where booking_date_id = b.id;
  update booking_date set starts_at = p_from, ends_at = p_to,
         released_minutes = released_minutes + (extract(epoch from (b.ends_at - b.starts_at) - (p_to - p_from)) / 60)::int
   where id = b.id;
  insert into blocked_slot (tenant_id, space_id, is_claim, during, booking_date_id)
  select b.tenant_id, a.space_id, a.is_claim, tstzrange(p_from, p_to + buf * interval '1 minute', '[)'), b.id from affected_spaces(b.space_id) a;
end $$;
grant execute on function trim_booking_date(uuid, timestamptz, timestamptz) to cwui_app;

-- ------------------------------------------------------------ text alerts
alter table app_user
  add column phone text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column sms_opt_in boolean not null default false,
  add column sms_opt_in_at timestamptz;

-- ------------------------------------------------------------ row-level security for the new tables
do $$
declare t text;
begin
  foreach t in array array['team','team_slot'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on team, team_slot to cwui_app;

insert into schema_migration (version) values ('007_close_gaps');
commit;
