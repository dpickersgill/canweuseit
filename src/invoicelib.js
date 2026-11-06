// Shared invoice helpers (numbering, deposits). Call inside withTenant.
export async function nextInvoiceNumber(c, tenantId) {
  await c.query('select pg_advisory_xact_lock(hashtext($1))', [`invoice:${tenantId}`]);
  const n = (await c.query('select count(*)::int n from invoice')).rows[0].n + 1;
  return `INV-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
}

// When the tenant asks for a deposit, an approved request gets one deposit invoice (once).
export async function ensureDeposit(c, { tenantId, requestId, userId }) {
  const t = (await c.query('select deposit_cents from tenant where id = $1', [tenantId])).rows[0];
  if (!t || !t.deposit_cents) return null;
  if ((await c.query("select 1 from invoice where request_id = $1 and kind = 'deposit' and status <> 'void'", [requestId])).rowCount) return null;
  const r = (await c.query('select organization_id, title from request where id = $1', [requestId])).rows[0];
  const number = await nextInvoiceNumber(c, tenantId);
  const inv = (await c.query(
    "insert into invoice (tenant_id, organization_id, request_id, number, amount_cents, due_on, note, created_by, kind) values ($1,$2,$3,$4,$5, current_date + 14, $6, $7, 'deposit') returning id, number",
    [tenantId, r.organization_id, requestId, number, t.deposit_cents, 'Refundable deposit', userId])).rows[0];
  await c.query('insert into invoice_line (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)',
    [tenantId, inv.id, `Refundable deposit for ${r.title}`.slice(0, 300), t.deposit_cents]);
  return inv;
}
