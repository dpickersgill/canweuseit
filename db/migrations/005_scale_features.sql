-- 005: multi-field requests, waitlist, group applications, allocation rounds, permits, insurance files,
-- notice windows, site-scoped staff, fees and invoices.
begin;

-- ------------------------------------------------------------ requests: a label per date (team name), rounds, tiers
alter table booking_date add column label text;
alter table booking_date add column late_cancel boolean not null default false;

create table allocation_round (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  name              text not null,
  opens_at          timestamptz not null,
  closes_at         timestamptz not null,
  season_start      date not null,
  season_end        date not null,
  max_hours_per_org numeric(8,1),
  status            text not null default 'open' check (status in ('open','closed')),
  created_at        timestamptz not null default now(),
  unique (tenant_id, id),
  check (closes_at > opens_at),
  check (season_end >= season_start)
);

alter table request add column round_id uuid;
alter table request add constraint request_round_fk foreign key (tenant_id, round_id) references allocation_round (tenant_id, id);

-- Higher tier wins when the queue is ordered (for example 5 school, 4 certified non-profit, 3 default, 1 for-profit).
alter table organization add column tier int not null default 3 check (tier between 1 and 5);

-- ------------------------------------------------------------ waitlist
create table waitlist (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  organization_id uuid not null,
  user_id         uuid not null references app_user(id),
  space_id        uuid not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  note            text,
  status          text not null default 'open' check (status in ('open','notified','cancelled')),
  created_at      timestamptz not null default now(),
  notified_at     timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, organization_id) references organization (tenant_id, id),
  foreign key (tenant_id, space_id) references space (tenant_id, id),
  check (ends_at > starts_at)
);

-- ------------------------------------------------------------ group applications (public form)
create table group_application (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  name           text not null,
  kind           text not null default 'club' check (kind in ('club','school','league','other')),
  contact_name   text not null,
  contact_email  text not null,
  notes          text,
  status         text not null default 'pending' check (status in ('pending','approved','declined')),
  created_at     timestamptz not null default now(),
  decided_by     uuid references app_user(id),
  decided_at     timestamptz,
  organization_id uuid,
  unique (tenant_id, id)
);

-- Anyone can submit; this is the only door the public form uses.
create function public_tenant(p_slug text) returns table (name text)
language sql stable security definer set search_path = public as $$
  select name from tenant where slug = p_slug and status = 'active'
$$;
create function apply_for_group(p_slug text, p_name text, p_kind text, p_contact text, p_email text, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_id uuid;
begin
  select id into v_tenant from tenant where slug = p_slug and status = 'active';
  if v_tenant is null then raise exception 'unknown group' using errcode = 'P0002'; end if;
  if (select count(*) from group_application where tenant_id = v_tenant and lower(contact_email) = lower(p_email) and created_at > now() - interval '1 day') >= 3
     or (select count(*) from group_application where tenant_id = v_tenant and created_at > now() - interval '1 day') >= 100 then
    raise exception 'too many applications' using errcode = 'P0001';
  end if;
  insert into group_application (tenant_id, name, kind, contact_name, contact_email, notes)
  values (v_tenant, left(p_name, 120), p_kind, left(p_contact, 120), left(p_email, 254), left(p_notes, 1000)) returning id into v_id;
  return v_id;
end $$;
revoke all on function public_tenant(text), apply_for_group(text, text, text, text, text, text) from public;
grant execute on function public_tenant(text), apply_for_group(text, text, text, text, text, text) to cwui_app;

-- ------------------------------------------------------------ permits, insurance files, policies
alter table compliance_document drop constraint if exists compliance_document_kind_check;
alter table compliance_document add constraint compliance_document_kind_check
  check (kind in ('insurance','permit','waiver','background_check','other'));
alter table compliance_document
  add column coverage_amount bigint,
  add column additional_insured boolean not null default false,
  add column file_name text,
  add column file_type text,
  add column file_data bytea;

alter table tenant
  add column cancel_notice_hours int not null default 0 check (cancel_notice_hours >= 0),
  add column hold_unpaid boolean not null default false;

create table permit (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  request_id  uuid not null,
  number      text not null,
  code        text not null unique,
  issued_at   timestamptz not null default now(),
  issued_by   uuid references app_user(id),
  revoked_at  timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, request_id) references request (tenant_id, id)
);

-- Public check page: anyone holding the code can see whether a permit is valid and what it covers.
create function permit_lookup(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'number', p.number, 'valid', (p.revoked_at is null and r.status = 'approved'), 'issuedAt', p.issued_at,
    'tenant', t.name, 'timezone', t.timezone, 'organization', o.name, 'title', r.title,
    'dates', coalesce((select jsonb_agg(jsonb_build_object('startsAt', bd.starts_at, 'endsAt', bd.ends_at, 'space', s.name, 'facility', f.name, 'label', bd.label) order by bd.starts_at)
                         from booking_date bd join space s on s.id = bd.space_id join facility f on f.id = s.facility_id
                        where bd.request_id = r.id and bd.status = 'confirmed'), '[]'::jsonb))
    from permit p join request r on r.id = p.request_id join organization o on o.id = r.organization_id join tenant t on t.id = p.tenant_id
   where p.code = p_code
$$;
revoke all on function permit_lookup(text) from public;
grant execute on function permit_lookup(text) to cwui_app;

-- ------------------------------------------------------------ site-scoped staff and a grounds role
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'role_assignment'::regclass and contype = 'c' loop
    execute format('alter table role_assignment drop constraint %I', c.conname);
  end loop;
end $$;
alter table role_assignment add column facility_id uuid;
alter table role_assignment add constraint role_assignment_facility_fk foreign key (tenant_id, facility_id) references facility (tenant_id, id);
alter table role_assignment add constraint role_assignment_role_check check (role in ('tenant_admin','approver','grounds','org_admin','booker','viewer'));
alter table role_assignment add constraint role_assignment_shape check (
  (role in ('tenant_admin','approver','grounds') and organization_id is null) or
  (role in ('org_admin','booker') and organization_id is not null and facility_id is null) or
  (role = 'viewer'));
alter table role_assignment add constraint role_assignment_facility_only check (facility_id is null or role in ('approver','grounds'));
drop index role_assignment_unique;
create unique index role_assignment_unique on role_assignment (tenant_id, user_id, role,
  coalesce(organization_id, '00000000-0000-0000-0000-000000000000'), coalesce(facility_id, '00000000-0000-0000-0000-000000000000'));

drop function user_tenants(uuid);
create function user_tenants(p_user uuid) returns table (tenant_id uuid, role text, organization_id uuid, facility_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, role, organization_id, facility_id from role_assignment where user_id = p_user
$$;
revoke all on function user_tenants(uuid) from public;
grant execute on function user_tenants(uuid) to cwui_app;

-- ------------------------------------------------------------ fees and invoices (recorded by staff; no online payment yet)
create table fee_rate (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  facility_id   uuid,
  space_id      uuid,
  org_kind      text check (org_kind in ('club','school','league','other')),
  cents_per_hour int not null check (cents_per_hour >= 0),
  note          text,
  unique (tenant_id, id),
  foreign key (tenant_id, facility_id) references facility (tenant_id, id),
  foreign key (tenant_id, space_id) references space (tenant_id, id)
);

create table invoice (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  organization_id uuid not null,
  request_id      uuid,
  number          text not null,
  status          text not null default 'open' check (status in ('open','paid','void')),
  amount_cents    int not null check (amount_cents >= 0),
  due_on          date not null,
  note            text,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_user(id),
  paid_at         timestamptz,
  paid_method     text,
  paid_ref        text,
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, organization_id) references organization (tenant_id, id),
  foreign key (tenant_id, request_id) references request (tenant_id, id)
);
create table invoice_line (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  invoice_id   uuid not null,
  description  text not null,
  amount_cents int not null,
  foreign key (tenant_id, invoice_id) references invoice (tenant_id, id) on delete cascade
);

-- ------------------------------------------------------------ row-level security and grants for the new tables
do $$
declare t text;
begin
  foreach t in array array['allocation_round','waitlist','group_application','permit','fee_rate','invoice','invoice_line'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on allocation_round, waitlist, group_application, permit, fee_rate, invoice, invoice_line to cwui_app;

insert into schema_migration (version) values ('005_scale_features');
commit;
