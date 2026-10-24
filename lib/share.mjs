// Link previews. Facebook, LINE and X read the page's og: tags without running its script, so the
// server fills them in: full URLs, the picture in the link's language (?lang=), and for a shared
// trip (?fn=...&tn=...) its own title, "กรุงเทพฯ → เชียงใหม่".

const TEXT = {
  th: {
    title: 'EVROUTE · วางแผนชาร์จ EV ทั่วไทย',
    desc: 'รู้ก่อนออกเดินทาง: แวะชาร์จที่ไหน นานเท่าไร ค่าไฟเท่าไร ทุกรุ่นรถ EV ฟรี ไม่ต้องสมัคร',
    trip: (a, b) => a + ' → ' + b + ' · แผนชาร์จ EV | EVROUTE',
    tripDesc: 'ดูจุดแวะชาร์จ เวลา และค่าไฟของทริปนี้ ปรับรุ่นรถและแบตของคุณได้ ฟรี ไม่ต้องสมัคร',
    image: 'assets/og.png', locale: 'th_TH',
  },
  en: {
    title: 'EVROUTE · Plan your EV trips in Thailand',
    desc: 'Know before you go: where to charge, for how long, and what it costs. Every EV model, free, no sign-up.',
    trip: (a, b) => a + ' → ' + b + ' · EV charging plan | EVROUTE',
    tripDesc: 'See this trip\'s charging stops, times and costs, and adjust them for your car. Free, no sign-up.',
    image: 'assets/og-en.png', locale: 'en_GB',
  },
  zh: {
    title: 'EVROUTE · 泰国电动车充电路线规划',
    desc: '出发前就知道：在哪充电、充多久、花多少钱。支持所有电动车型，免费，无需注册。',
    trip: (a, b) => a + ' → ' + b + ' · 电动车充电规划 | EVROUTE',
    tripDesc: '查看这趟行程的充电站、时间和费用，可按您的车型调整。免费，无需注册。',
    image: 'assets/og-zh.png', locale: 'zh_CN',
  },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const place = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '');

// Source-tracking parameters say where a visitor came from; they don't belong in a shared link.
export const TRACKING = ['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'];

// html: index.html as written; base: "https://host"; url: the request's URL.
export function shareMeta(html, base, url) {
  const q = url.searchParams, t = TEXT[q.get('lang')] || TEXT.th;
  const from = place(q.get('fn')), to = place(q.get('tn'));
  const title = from && to ? t.trip(from, to) : t.title;
  const clean = new URL(url.pathname + url.search, base);
  TRACKING.forEach((k) => clean.searchParams.delete(k));
  const set = (prop, value) => {
    html = html.replace(new RegExp('(<meta (?:property|name)="' + prop + '" content=")[^"]*(")'), (m, a, b) => a + esc(value) + b);
  };
  set('og:title', title);
  set('og:description', from && to ? t.tripDesc : t.desc);
  set('og:image', base + '/' + t.image);
  set('og:url', clean.toString());
  set('og:locale', t.locale);
  return html;
}
