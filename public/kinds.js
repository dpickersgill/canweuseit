// The kinds of space a school, township or league rents out. Shared by the server and the browser.
// where: 'out' always outdoors, 'in' always indoors, 'either' the admin says which.
// pitch: drawn as a grass pitch in pickers; everything else is drawn as a venue card.
export const SPACE_KINDS = [
  { code: 'field', label: 'Field', plural: 'Fields', icon: 'land-plot', where: 'out', pitch: true },
  { code: 'diamond', label: 'Ball diamond', plural: 'Ball diamonds', icon: 'diamond', where: 'out', pitch: true },
  { code: 'court', label: 'Court', plural: 'Courts', icon: 'dribbble', where: 'either' },
  { code: 'track', label: 'Track', plural: 'Tracks', icon: 'route', where: 'either' },
  { code: 'pool', label: 'Pool', plural: 'Pools', icon: 'waves', where: 'either' },
  { code: 'rink', label: 'Rink', plural: 'Rinks', icon: 'snowflake', where: 'either' },
  { code: 'pavilion', label: 'Pavilion', plural: 'Pavilions', icon: 'tent', where: 'out' },
  { code: 'park', label: 'Park or picnic area', plural: 'Parks and picnic areas', icon: 'trees', where: 'out' },
  { code: 'lot', label: 'Parking lot', plural: 'Parking lots', icon: 'square-parking', where: 'out' },
  { code: 'gym', label: 'Gym', plural: 'Gyms', icon: 'dumbbell', where: 'in' },
  { code: 'classroom', label: 'Classroom', plural: 'Classrooms', icon: 'school', where: 'in' },
  { code: 'multipurpose', label: 'Multi-purpose room', plural: 'Multi-purpose rooms', icon: 'door-open', where: 'in' },
  { code: 'meeting', label: 'Meeting room', plural: 'Meeting rooms', icon: 'presentation', where: 'in' },
  { code: 'auditorium', label: 'Auditorium or stage', plural: 'Auditoriums', icon: 'theater', where: 'in' },
  { code: 'cafeteria', label: 'Cafeteria', plural: 'Cafeterias', icon: 'utensils', where: 'in' },
  { code: 'kitchen', label: 'Kitchen', plural: 'Kitchens', icon: 'chef-hat', where: 'in' },
  { code: 'library', label: 'Library or media center', plural: 'Libraries', icon: 'library', where: 'in' },
  { code: 'other', label: 'Other', plural: 'Other spaces', icon: 'map-pin', where: 'either' },
];
export const KIND_CODES = SPACE_KINDS.map((k) => k.code);
const BY = new Map(SPACE_KINDS.map((k) => [k.code, k]));
export const kindOf = (code) => BY.get(code) || BY.get('other');
// The indoor default for a new space of this kind.
export const defaultIndoor = (code) => kindOf(code).where === 'in';
// Match what someone typed in a spreadsheet ("Pavilion", "multi purpose room", "gym") to a kind code.
export function kindFromText(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return 'field';
  for (const k of SPACE_KINDS) if (t === k.code || t === k.label.toLowerCase().replace(/[^a-z]/g, '') || t === k.plural.toLowerCase().replace(/[^a-z]/g, '')) return k.code;
  if (t.includes('parking')) return 'lot';
  for (const k of SPACE_KINDS) if (k.code !== 'other' && t.includes(k.code)) return k.code; // "picnic pavilion", "tennis court"
  const words = { room: 'multipurpose', mpr: 'multipurpose', gymnasium: 'gym', baseball: 'diamond', softball: 'diamond', pitch: 'field', stage: 'auditorium', tennis: 'court', basketball: 'court', pickleball: 'court', picnic: 'park', shelter: 'pavilion', parking: 'lot', media: 'library' };
  for (const [w, code] of Object.entries(words)) if (t.includes(w)) return code;
  return null;
}
