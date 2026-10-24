// Flooded roads, for steering trips around them. Ported from medtrackq/roadflood (floods.js):
// Longdo Traffic's event feed (Department of Highways and Longdo users, all of Thailand) and the
// Bangkok drainage department's road sensors (via POPNIX). The server reads both every few
// minutes and hands the page one short list.

export const LONGDO = 'https://event.longdo.com/feed/json';
export const BKK_SENSORS = 'https://flood.pop.in.th/api_roads.php';

const DAY = 24 * 3600 * 1000;

// Feed times are Thai local time without a zone.
function parseTH(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + '+07:00');
  return Number.isFinite(t) ? t : null;
}

// `start` is when the flooding began, not when it was last checked. The Department of Highways
// re-sends every open report several times a day, each time pushing `stop` to sync time + 24 h,
// so stop - 24 h is the last time the department confirmed it. A Longdo user's report is never
// re-sent, so its report time is all there is.
function fromEvent(e, now) {
  const title = e.title || '', desc = e.description || '', all = title + ' ' + desc;
  const status = /ผ่านไม่ได้|ไม่สามารถผ่านได้|ปิดการจราจร/.test(all) ? 'closed' : /ผ่านได้/.test(title) ? 'open' : 'report';
  const prov = (desc.match(/จ\.\s*([^\s,()]+)/) || title.match(/จ\.\s*([^\s,()]+)/) || [])[1] || '';
  const amp = (desc.match(/อ\.\s*([^\s,()]+)/) || [])[1];
  const kmPost = (desc.match(/กม\.\s*ที่\s*([\d+]+\s*-\s*[\d+]+|[\d+]+)/) || [])[1];
  const place = [kmPost ? 'กม. ' + kmPost.replace(/\s+/g, '') : '', amp ? 'อ.' + amp : '', prov ? 'จ.' + prov : ''].filter(Boolean).join(' · ');
  // Highway reports rarely give a depth; use one only when the text states it in centimetres.
  const depth = (all.match(/(?:ลึก|ระดับน้ำ|สูง)\D{0,12}(\d{1,3})\s*(?:ซม|ซ\.ม|เซนติเมตร|cm)/i) || [])[1];
  const agency = e.contributor === 'DOH Admin';
  const stop = parseTH(e.stop);
  return {
    id: 'e' + e.eid,
    status,
    small: /รถเล็ก/.test(all) && status === 'closed',
    depth: depth ? +depth : null,
    title: title.replace(/\s*\((ผ่านได้|ผ่านไม่ได้)\)\s*$/, ''),
    place: place || desc.split('\n')[0].slice(0, 90),
    lat: +e.latitude, lng: +e.longitude,
    start: parseTH(e.start),
    confirmed: agency && stop ? Math.min(now, stop - DAY) : parseTH(e.start),
    agency,
    src: agency ? 'กรมทางหลวง' : 'ผู้ใช้ Longdo Traffic',
  };
}

function fromSensor(r) {
  return {
    id: 's' + r.code,
    status: 'sensor',
    small: false,
    depth: Number.isFinite(+r.depth) ? +r.depth : null,
    title: r.name || '',
    place: [r.kind === 2 ? 'อุโมงค์' : '', r.district ? 'เขต' + r.district : '', 'กรุงเทพฯ'].filter(Boolean).join(' · '),
    lat: +r.lat, lng: +r.lng,
    start: parseTH(r.since || r.measured_at),
    confirmed: parseTH(r.measured_at),
    agency: true,
    src: 'เซ็นเซอร์ สำนักการระบายน้ำ กทม.',
  };
}

// How bad a point is for an EV. The battery sits under the floor, so the planner treats every EV
// like a low car (roadflood's "รถเก๋ง/รถเล็ก"): it steers around roads closed to traffic, roads
// closed to small cars and water 20 cm or deeper (block), and only warns about the rest.
export function severity(it) {
  const d = it.depth;
  if (it.status === 'closed' && !it.small) return { sev: 'closed', label: 'ผ่านไม่ได้', block: true, rank: 4 };
  if (it.status === 'closed') return { sev: 'small', label: 'รถเล็กผ่านไม่ได้', block: true, rank: 3 };
  if (d != null && d >= 20) return { sev: 'deep', label: 'น้ำลึก ' + d + ' ซม.', block: true, rank: 3 };
  if (d != null && d >= 10) return { sev: 'mid', label: 'น้ำลึก ' + d + ' ซม.', block: false, rank: 2 };
  if (d != null && d > 0) return { sev: 'low', label: 'น้ำ ' + d + ' ซม.', block: false, rank: 1 };
  if (it.status === 'open' || it.status === 'sensor') return { sev: 'open', label: 'ผ่านได้ ระวัง', block: false, rank: 2 };
  return { sev: 'report', label: 'ยังไม่ยืนยัน', block: false, rank: 1 };
}

// events: Longdo's feed (an array); sensors: POPNIX's answer ({ roads }). Either may be missing.
// A point not re-checked for a day (sensors: 2 hours) is dropped: an old report says nothing about
// today, and roadflood shows those only with a warning. The feed often carries the same point many
// times over (one highway stretch, a report per update); one per spot is kept, the worst.
export function floodList(events, sensors, now = Date.now()) {
  const best = new Map();
  for (const it of allFloods(events, sensors, now)) {
    const key = it.lat.toFixed(4) + ',' + it.lng.toFixed(4), had = best.get(key);
    if (!had || it.rank > had.rank || (it.rank === had.rank && it.confirmed > had.confirmed)) best.set(key, it);
  }
  return [...best.values()].sort((a, b) => b.rank - a.rank || (a.confirmed < b.confirmed ? 1 : -1));
}

function allFloods(events, sensors, now) {
  const items = [
    ...(Array.isArray(events) ? events : []).filter((e) => e && (e.icon === 'flood' || String(e.type) === '6')).map((e) => fromEvent(e, now)),
    ...((sensors && sensors.roads) || []).filter((r) => r && (r.level === 'flood' || r.level === 'slight')).map(fromSensor),
  ];
  return items
    .filter((it) => Number.isFinite(it.lat) && Number.isFinite(it.lng) && it.lat && it.lng)
    .filter((it) => it.confirmed && now - it.confirmed <= (it.status === 'sensor' ? DAY / 12 : DAY))
    .map((it) => ({ ...it, ...severity(it), start: it.start && new Date(it.start).toISOString(), confirmed: new Date(it.confirmed).toISOString() }));
}
