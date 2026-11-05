-- 003: whether a space has lights (matters for evening requests and fees).
begin;
alter table space add column has_lights boolean not null default false;
insert into schema_migration (version) values ('003_space_lights');
commit;
