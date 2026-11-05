-- Seed for the White Horse Rugby tenant (staging). Run as cwui_owner. Safe to re-run.
-- Veterans Park: one lit field. Friendship: one unlit field made of an upper and a lower field.
begin;
select set_config('app.tenant_id', (select id::text from tenant where slug = 'white-horse-rugby'), true);

insert into facility (tenant_id, name) select current_tenant(), n from (values ('Veterans Park'), ('Friendship')) v(n)
  on conflict (tenant_id, name) do nothing;

insert into space (tenant_id, facility_id, name, kind, has_lights)
select current_tenant(), f.id, 'Veterans Park Field', 'field', true
from facility f where f.name = 'Veterans Park' and f.tenant_id = current_tenant()
  and not exists (select 1 from space s where s.tenant_id = current_tenant() and s.name = 'Veterans Park Field');

insert into space (tenant_id, facility_id, name, kind, has_lights)
select current_tenant(), f.id, 'Friendship Field', 'field', false
from facility f where f.name = 'Friendship' and f.tenant_id = current_tenant()
  and not exists (select 1 from space s where s.tenant_id = current_tenant() and s.name = 'Friendship Field');

insert into space (tenant_id, facility_id, parent_id, name, kind, has_lights)
select current_tenant(), p.facility_id, p.id, v.n, 'field', false
from space p, (values ('Friendship Upper Field'), ('Friendship Lower Field')) v(n)
where p.tenant_id = current_tenant() and p.name = 'Friendship Field'
  and not exists (select 1 from space s where s.tenant_id = current_tenant() and s.name = v.n);

select f.name as facility, coalesce(par.name || ' > ', '') || s.name as space, s.has_lights
from space s join facility f on f.id = s.facility_id left join space par on par.id = s.parent_id
where s.tenant_id = current_tenant() order by 1, 2;
commit;
