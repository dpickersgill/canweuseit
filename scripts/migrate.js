// Applies db/migrations/*.sql in order, as the OWNER role (never the app role).
// Env: DB_HOST, DB_PORT, DB_NAME, DB_USER (cwui_owner), DB_PASSWORD
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const client = new pg.Client({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
await client.connect();
const { rows: [{ exists }] } = await client.query("select to_regclass('public.schema_migration') is not null as exists");
const done = new Set(exists ? (await client.query('select version from schema_migration')).rows.map((r) => r.version) : []);
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const version = file.replace(/\.sql$/, '');
  if (done.has(version)) { console.log(`skip   ${version}`); continue; }
  console.log(`apply  ${version}`);
  await client.query(fs.readFileSync(path.join(dir, file), 'utf8')); // each file manages its own transaction and records its own version
}
await client.end();
console.log('migrations up to date');
