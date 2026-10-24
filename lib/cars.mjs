// Car models added or changed on the admin page (the cars table in Supabase), on top of the list
// in assets/js/cars.js. The page loads them as /api/cars.js right after cars.js, so a model added
// in the admin shows up without a deploy. A row with the id of a listed model replaces its figures;
// "hidden" takes a model off the list (e.g. no longer sold).

const PLUGS = ['CCS2', 'CHAdeMO', 'GBT', 'Tesla'];
const num = (v, lo, hi) => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10) / 10 : null; };
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// An id from the brand and model, like the ones in cars.js: "avatr-12-long-range".
export function carId(brand, model) {
  return (text(brand, 30) + '-' + text(model, 60)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// A row from the admin form, or { error } saying what is wrong.
export function cleanCar(d) {
  if (!d || typeof d !== 'object') return { error: 'ข้อมูลไม่ครบ' };
  const brand = text(d.brand, 30), model = text(d.model, 60);
  if (!brand) return { error: 'ใส่ยี่ห้อ' };
  if (!model) return { error: 'ใส่รุ่น' };
  if (brand === 'อื่น ๆ') return { error: 'ใช้ยี่ห้อจริงของรถ' };
  const id = typeof d.id === 'string' && d.id ? d.id.trim().toLowerCase() : carId(brand, model);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || id === 'custom') return { error: 'รหัสรุ่น (id) ใช้ได้เฉพาะ a-z 0-9 และ - ยาว 2–40 ตัว' };
  const hidden = d.hidden === true;
  const kwh = num(d.kwh, 10, 200), use = num(d.use, 8, 40), dc = num(d.dc, 0, 400), ac = num(d.ac, 0, 22);
  if (!hidden) {
    if (kwh == null) return { error: 'แบตที่ใช้ได้ต้องอยู่ระหว่าง 10–200 kWh' };
    if (use == null) return { error: 'กินไฟต้องอยู่ระหว่าง 8–40 kWh/100 กม.' };
    if (dc == null) return { error: 'DC สูงสุดต้องอยู่ระหว่าง 0–400 kW' };
  }
  const plugs = Array.isArray(d.plugs) ? PLUGS.filter((p) => d.plugs.includes(p)) : ['CCS2'];
  return { id, brand, model, kwh, use, dc, ac: ac == null ? 7 : ac, plugs: dc ? plugs : [], hidden, note: text(d.note, 200) || null };
}

// The script the page loads after cars.js. Rows replace listed models of the same id, hidden rows
// remove them, and new models go before "ไม่มีรุ่นของฉัน" (always last).
export function carsScript(rows) {
  const list = (rows || []).map((r) => (r.hidden ? { id: r.id, hidden: true }
    : { id: r.id, brand: r.brand, model: r.model, kwh: Number(r.kwh), use: Number(r.use), dc: Number(r.dc), ac: Number(r.ac) || 7, plugs: Array.isArray(r.plugs) ? r.plugs : ['CCS2'] }));
  return '// Car models from the admin page (lib/cars.mjs).\n(function (C, X) {\n' +
    '  if (!C) return;\n' +
    '  X.forEach(function (x) {\n' +
    '    var i = -1;\n' +
    '    C.forEach(function (c, k) { if (c.id === x.id) i = k; });\n' +
    '    if (x.hidden) { if (i >= 0) C.splice(i, 1); return; }\n' +
    '    if (i >= 0) { C[i] = x; return; }\n' +
    "    var end = C.length && C[C.length - 1].id === 'custom' ? C.length - 1 : C.length;\n" +
    '    C.splice(end, 0, x);\n' +
    '  });\n' +
    '})(window.EVCars, ' + JSON.stringify(list).replace(/</g, '\\u003c') + ');\n';
}
