import { sunTimes } from './sun.js';

const fmtMin = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

// Local calendar day, minutes since midnight, and weekday for an instant in a time zone.
export function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, minutes: Number(p.hour) * 60 + Number(p.minute), dow: new Date(`${day}T12:00:00Z`).getUTCDay() };
}
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

// Checks each date against the group's rules. Returns [{ blocks: [msg], warnings: [msg] }] in the same order as `dates`.
//   hours rules (space_hours), daylight rule for unlit outdoor spaces, insurance rule for the organization.
export async function checkDates(c, { tenant, spaceId, organizationId, dates }) {
  const tz = tenant.timezone;
  const { rows: chain } = await c.query(
    'select id, has_lights, indoor from space where id = $1 or id in (select space_ancestors($1))', [spaceId]);
  const lit = chain.some((s) => s.has_lights || s.indoor); // indoor spaces have their own lighting
  const ids = chain.map((s) => s.id);
  const { rows: hours } = await c.query(
    'select weekdays, opens, closes, starts_on::text, ends_on::text, enforcement, note from space_hours where space_id is null or space_id = any($1)', [ids]);
  let docs = [];
  if (tenant.insurance_rule !== 'off') {
    docs = (await c.query("select expires_on::text, coverage_amount, additional_insured from compliance_document where organization_id = $1 and kind = 'insurance'", [organizationId])).rows;
  }

  return dates.map((d) => {
    const s = localParts(d.startsAt, tz), e = localParts(d.endsAt, tz);
    const endMin = e.day === s.day ? e.minutes : 24 * 60;
    const blocks = [], warnings = [];
    const push = (level, msg) => (level === 'block' ? blocks : warnings).push(msg);

    // bookable hours
    const live = hours.filter((h) => h.weekdays.includes(s.dow) && (!h.starts_on || h.starts_on <= s.day) && (!h.ends_on || h.ends_on >= s.day));
    if (live.length && !live.some((h) => toMin(h.opens) <= s.minutes && endMin <= toMin(h.closes))) {
      const windows = live.map((h) => `${fmtMin(toMin(h.opens))} to ${fmtMin(toMin(h.closes))}`).join(' or ');
      push(live.some((h) => h.enforcement === 'block') ? 'block' : 'warn', `Outside bookable hours (${windows})${live[0].note ? `: ${live[0].note}` : ''}`);
    }
    // no lights: must finish before sunset
    if (tenant.daylight_rule !== 'off' && !lit && tenant.latitude != null && tenant.longitude != null) {
      const sun = sunTimes(s.day, Number(tenant.latitude), Number(tenant.longitude));
      if (sun && d.endsAt > sun.sunset) {
        push(tenant.daylight_rule, `Ends after sunset (${fmtMin(localParts(sun.sunset, tz).minutes)}) and this space has no lights`);
      }
    }
    // insurance on file covering the date
    if (tenant.insurance_rule !== 'off') {
      const current = docs.filter((x) => !x.expires_on || x.expires_on >= s.day);
      const ok = current.filter((x) => (tenant.min_coverage == null || Number(x.coverage_amount || 0) >= Number(tenant.min_coverage)) && (!tenant.require_additional_insured || x.additional_insured));
      if (!current.length) push(tenant.insurance_rule, 'No insurance on file covering this date');
      else if (!ok.length) push(tenant.insurance_rule, tenant.min_coverage != null && !current.some((x) => Number(x.coverage_amount || 0) >= Number(tenant.min_coverage))
        ? `Insurance on file is below the required $${Number(tenant.min_coverage).toLocaleString('en-US')} coverage` : 'Insurance on file does not name the facility as additional insured');
    }
    return { blocks, warnings };
  });
}

// One readable sentence from many per-date results (groups identical messages).
export function summarize(results, dates, tz, key) {
  const by = new Map();
  results.forEach((r, i) => r[key].forEach((m) => { if (!by.has(m)) by.set(m, []); by.get(m).push(i); }));
  return [...by].map(([msg, idx]) => {
    const label = (i) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(dates[i].startsAt);
    const shown = idx.slice(0, 3).map(label).join(', ');
    return `${msg} (${shown}${idx.length > 3 ? ` and ${idx.length - 3} more` : ''})`;
  });
}
