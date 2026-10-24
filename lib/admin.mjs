// The admin page's numbers (admin.html), worked out from rows the server reads from Supabase.
// Only signed-in users whose email is in ADMIN_EMAILS can ask for them.

export function adminEmails(v) {
  return String(v || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
}

const bkkDay = (t) => new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(0, 10);

function topCounts(rows, keyOf, n) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

// rows: { opens, plans, events, users, errors, feedback, problems, charges } as Supabase returns
// them (created_at in ISO). Days are Bangkok calendar days, the last `days` of them.
export function summarize(rows, now = Date.now(), days = 30) {
  const today = bkkDay(new Date(now).toISOString());
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(bkkDay(new Date(now - i * 864e5).toISOString()));
  const byDay = Object.fromEntries(dayList.map((d) => [d, { day: d, people: new Set(), opens: 0, plans: 0, signups: 0 }]));

  const devDays = new Map(); // dev -> set of days seen
  for (const o of rows.opens || []) {
    const d = byDay[bkkDay(o.created_at)];
    if (!d) continue;
    d.opens++;
    if (o.dev) {
      d.people.add(o.dev);
      (devDays.get(o.dev) || devDays.set(o.dev, new Set()).get(o.dev)).add(d.day);
    }
  }
  for (const p of rows.plans || []) { const d = byDay[bkkDay(p.created_at)]; if (d) d.plans++; }
  const users = rows.users || [];
  for (const u of users) { const d = byDay[bkkDay(u.created_at)]; if (d) d.signups++; }

  const people = (n) => {
    const set = new Set();
    dayList.slice(-n).forEach((d) => byDay[d].people.forEach((x) => set.add(x)));
    return set.size;
  };
  const langs = {};
  const lastLang = new Map(); // each browser's latest language in the period
  for (const o of rows.opens || []) {
    if (!o.dev || !o.lang || !byDay[bkkDay(o.created_at)]) continue;
    const prev = lastLang.get(o.dev);
    if (!prev || o.created_at > prev.at) lastLang.set(o.dev, { at: o.created_at, lang: o.lang });
  }
  lastLang.forEach((x) => { langs[x.lang] = (langs[x.lang] || 0) + 1; });

  // The same message from many browsers is one problem: grouped, newest first.
  const errMap = new Map();
  for (const e of rows.errors || []) {
    const k = (e.src || '') + '|' + (e.msg || '') + '|' + (e.at || '');
    const g = errMap.get(k) || errMap.set(k, { src: e.src, msg: e.msg, at: e.at, count: 0, people: new Set(), last: e.created_at, first: e.created_at, ua: e.ua, page: e.page }).get(k);
    g.count++;
    if (e.dev) g.people.add(e.dev);
    if (e.created_at > g.last) { g.last = e.created_at; g.ua = e.ua; g.page = e.page; }
    if (e.created_at < g.first) g.first = e.created_at;
  }
  const errors = [...errMap.values()].map((g) => ({ ...g, people: g.people.size })).sort((a, b) => (b.last > a.last ? 1 : -1));
  const errDay = new Set(dayList.slice(-1));

  const events = (rows.events || []).filter((e) => e.kind !== 'arrive');
  // Where people came from: each source's visits, and how many different browsers.
  const src = new Map();
  for (const e of rows.events || []) {
    if (e.kind !== 'arrive' || !e.ref || !byDay[bkkDay(e.created_at)]) continue;
    const g = src.get(e.ref) || src.set(e.ref, { key: e.ref, visits: 0, people: new Set() }).get(e.ref);
    g.visits++;
    if (e.dev) g.people.add(e.dev);
  }
  const sources = [...src.values()].map((g) => ({ key: g.key, count: g.people.size || g.visits, visits: g.visits })).sort((a, b) => b.count - a.count || b.visits - a.visits);
  return {
    today,
    people: { today: people(1), week: people(7), month: people(days), returning: [...devDays.values()].filter((s) => s.size > 1).length },
    plans: { today: byDay[today]?.plans || 0, month: (rows.plans || []).length, failed: (rows.plans || []).filter((p) => p.ok === false).length },
    accounts: { total: users.length, month: users.filter((u) => byDay[bkkDay(u.created_at)]).length },
    charges: { month: (rows.charges || []).length, failed: (rows.charges || []).filter((c) => c.ok === false).length },
    daily: dayList.map((d) => ({ day: d, people: byDay[d].people.size, opens: byDay[d].opens, plans: byDay[d].plans, signups: byDay[d].signups })),
    langs,
    cars: topCounts(rows.plans || [], (p) => [p.brand, p.model].filter(Boolean).join(' '), 8),
    apps: topCounts(events.filter((e) => e.kind === 'app'), (e) => e.op, 8),
    actions: topCounts(events, (e) => e.kind, 12),
    sources,
    errors: errors.slice(0, 50),
    errorsToday: (rows.errors || []).filter((e) => errDay.has(bkkDay(e.created_at))).length,
    feedback: rows.feedback || [],
    feedbackNew: (rows.feedback || []).filter((f) => f.status !== 'done').length,
    problems: rows.problems || [],
  };
}
