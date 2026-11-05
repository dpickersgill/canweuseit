// Local wall-clock time in an IANA time zone -> UTC instant. Handles daylight saving.
function offsetMs(tz, utcMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

export function localToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm);
  let guess = asIfUtc - offsetMs(tz, asIfUtc);
  guess = asIfUtc - offsetMs(tz, guess); // second pass settles dates near a clock change
  return new Date(guess);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const isTime = (s) => typeof s === 'string' && TIME_RE.test(s);

// { startsOn, until, weekdays:[0-6 Sun-Sat], startTime, endTime } -> [{startsAt, endsAt}] in UTC. Max 200 dates.
export function expandWeekly({ startsOn, until, weekdays, startTime, endTime }, tz) {
  const out = [];
  const end = Date.parse(`${until}T00:00:00Z`);
  for (let t = Date.parse(`${startsOn}T00:00:00Z`); t <= end && out.length <= 200; t += 86400000) {
    const day = new Date(t);
    if (!weekdays.includes(day.getUTCDay())) continue;
    const ds = day.toISOString().slice(0, 10);
    out.push({ startsAt: localToUtc(ds, startTime, tz), endsAt: localToUtc(ds, endTime, tz) });
  }
  return out;
}
