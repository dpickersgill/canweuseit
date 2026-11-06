-- 008: calendar feeds and schedule pages for one team.
begin;
alter table calendar_feed add column team_id uuid;
alter table calendar_feed add constraint calendar_feed_team_fk foreign key (tenant_id, team_id) references team (tenant_id, id);
drop function feed_lookup(text);
create function feed_lookup(p_hash text) returns table (tenant_id uuid, organization_id uuid, team_id uuid)
language sql stable security definer set search_path = public as $$
  select tenant_id, organization_id, team_id from calendar_feed where token_hash = p_hash
$$;
revoke all on function feed_lookup(text) from public;
grant execute on function feed_lookup(text) to cwui_app;
insert into schema_migration (version) values ('008_team_feeds');
commit;
