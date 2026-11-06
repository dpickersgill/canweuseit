-- 006: minimum insurance coverage and additional-insured requirement.
begin;
alter table tenant
  add column min_coverage bigint check (min_coverage is null or min_coverage >= 0),
  add column require_additional_insured boolean not null default false;
insert into schema_migration (version) values ('006_insurance_rules');
commit;
