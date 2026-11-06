-- 010: more than fields. Schools, townships and parks departments also rent pavilions, courts, gyms,
-- classrooms, multi-purpose rooms and more. Each space gets a kind, whether it is indoors, and a capacity.
begin;

alter table space drop constraint if exists space_kind_check;
update space set kind = 'multipurpose' where kind = 'room';
alter table space add constraint space_kind_check check (kind in
  ('field','diamond','court','track','pool','rink','pavilion','park','lot',
   'gym','classroom','multipurpose','meeting','auditorium','cafeteria','kitchen','library','other'));
-- indoors: no sunset rule, and the lights setting does not apply
alter table space add column indoor boolean not null default false;
alter table space add column capacity int check (capacity between 1 and 100000);

-- a rate can apply to every space of one kind ("pavilions $40 an hour")
alter table fee_rate add column space_kind text;

update plan set blurb = 'One site, up to 4 spaces: fields, courts, pavilions or rooms. Requests, approvals, schedule, closures and calendar links.' where code = 'free';
update plan set blurb = 'Up to 3 sites and 15 spaces. Adds card payments and deposits.' where code = 'standard';
update plan set blurb = 'Unlimited sites and spaces. For school districts, townships and large leagues.' where code = 'pro';

insert into schema_migration (version) values ('010_space_kinds');
commit;
