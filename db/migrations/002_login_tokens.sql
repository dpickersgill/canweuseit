-- 002: one-time email sign-in links. Only a hash of the token is stored.
-- Platform-level table (sign-in happens before a tenant is chosen), so no row-level security.
begin;

create table login_token (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index login_token_email_created on login_token (lower(email), created_at);

grant select, insert, update, delete on login_token to cwui_app;

insert into schema_migration (version) values ('002_login_tokens');
commit;
