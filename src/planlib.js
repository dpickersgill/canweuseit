// What the tenant's plan allows, and how much of it is used. Call inside withTenant.
export async function planUsage(c, tenantId) {
  const p = (await c.query(
    `select p.code, p.name, p.included_fields, p.max_facilities, p.online_payments, p.base_price_cents
       from tenant t join plan p on p.code = t.plan_code where t.id = $1`, [tenantId])).rows[0];
  const n = (await c.query("select (select count(*) from facility)::int as facilities, (select count(*) from space where parent_id is null and active)::int as fields")).rows[0];
  // only the free plan caps fields; paid plans bill extra fields instead of blocking them
  const maxFields = p.code === 'free' ? p.included_fields : null;
  return { plan: p.code, name: p.name, priceCents: p.base_price_cents, onlinePayments: p.online_payments,
    maxFacilities: p.max_facilities, maxFields, facilities: n.facilities, fields: n.fields };
}
export const limitError = (what, u) => Object.assign(new Error(`The ${u.name} plan includes ${what === 'facility' ? `${u.maxFacilities} site${u.maxFacilities === 1 ? '' : 's'}` : `${u.maxFields} fields`}. Upgrade to add more.`), { http: 402 });
export async function checkLimit(c, tenantId, what) {
  const u = await planUsage(c, tenantId);
  if (what === 'facility' && u.maxFacilities != null && u.facilities >= u.maxFacilities) throw limitError(what, u);
  if (what === 'field' && u.maxFields != null && u.fields >= u.maxFields) throw limitError(what, u);
}
