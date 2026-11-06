-- 009: simpler, lower pricing (Free, Community, League), no platform fee on card payments,
-- and an owner console for the people who run CanWeUseIt itself (not tied to any group).
begin;

alter table plan add column annual_price_cents int not null default 0;
alter table plan add column blurb text;
update plan set name = 'Free', included_fields = 4, max_facilities = 1, base_price_cents = 0, annual_price_cents = 0, online_payments = false,
  blurb = 'One site, up to 4 fields. Requests, approvals, schedule, closures and calendar links.' where code = 'free';
update plan set name = 'Community', included_fields = 15, max_facilities = 3, base_price_cents = 2900, annual_price_cents = 29000, online_payments = true,
  blurb = 'Up to 3 sites and 15 fields. Adds card payments and deposits.' where code = 'standard';
update plan set name = 'League', included_fields = 1000, max_facilities = null, base_price_cents = 7900, annual_price_cents = 79000, online_payments = true,
  blurb = 'Unlimited sites and fields. For districts, towns and large leagues.' where code = 'pro';
-- the old $49 Starter plan goes away; anyone on it moves to League so nothing they use is taken away
update tenant set plan_code = 'pro' where plan_code = 'starter';
delete from plan where code = 'starter';
alter table tenant alter column plan_code set default 'free';
grant select on plan to cwui_app;

-- no CanWeUseIt cut of card payments; groups pay only Stripe's own fee
alter table tenant alter column platform_fee_bps set default 0;
update tenant set platform_fee_bps = 0;

-- ------------------------------------------------------------ owner console (crosses every group, so definer functions)
create function platform_tenants() returns table (id uuid, name text, slug text, plan_code text, status text, created_at timestamptz,
  sites int, fields int, groups int, pending int, admins text)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.slug, t.plan_code, t.status, t.created_at,
         (select count(*) from facility f where f.tenant_id = t.id)::int,
         (select count(*) from space s where s.tenant_id = t.id and s.parent_id is null and s.active)::int,
         (select count(*) from organization o where o.tenant_id = t.id)::int,
         (select count(*) from request r where r.tenant_id = t.id and r.status = 'pending')::int,
         (select string_agg(u.email, ', ' order by u.email) from role_assignment ra join app_user u on u.id = ra.user_id where ra.tenant_id = t.id and ra.role = 'tenant_admin')
    from tenant t order by t.created_at desc
$$;
create function platform_set_plan(p_tenant uuid, p_plan text) returns boolean
language sql security definer set search_path = public as $$
  update tenant set plan_code = p_plan where id = p_tenant and exists (select 1 from plan where code = p_plan) returning true
$$;
-- add the owner as an admin of a group, to help with support (recorded in that group's activity log)
create function platform_join(p_tenant uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from role_assignment where tenant_id = p_tenant and user_id = p_user and role = 'tenant_admin') then
    insert into role_assignment (tenant_id, user_id, role) values (p_tenant, p_user, 'tenant_admin');
    insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values (p_tenant, p_user, 'platform.join', 'tenant', p_tenant, '{}');
  end if;
end $$;
revoke all on function platform_tenants(), platform_set_plan(uuid, text), platform_join(uuid, uuid) from public;
grant execute on function platform_tenants(), platform_set_plan(uuid, text), platform_join(uuid, uuid) to cwui_app;

insert into schema_migration (version) values ('009_pricing_and_platform');
commit;
