// Sunrise and sunset for a date and place (NOAA solar calculator). Accurate to a couple of minutes.
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;

// dateStr 'YYYY-MM-DD', lat/lon in degrees (east positive). Returns { sunrise, sunset } as Date (UTC), or null in polar day/night.
export function sunTimes(dateStr, lat, lon) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jd = Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const yv = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(yv * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * yv * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * yv * yv * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const cosH = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))) - Math.tan(rad(lat)) * Math.tan(rad(decl));
  if (cosH > 1 || cosH < -1) return null;
  const ha = deg(Math.acos(cosH));
  const noon = 720 - 4 * lon - eqTime; // minutes after 00:00 UTC
  const at = (min) => new Date(Date.UTC(y, m - 1, d) + min * 60000);
  return { sunrise: at(noon - 4 * ha), sunset: at(noon + 4 * ha) };
}
