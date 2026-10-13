// Charging-stop planner. Pure functions shared by the page and the tests.
(function (root) {
  'use strict';

  var MAX_OFF_KM = 5;      // stations further than this from the route are ignored
  var ROAD_FACTOR = 1.3;   // driving distance to a station vs. straight-line distance from the route
  var DETOUR_KMH = 40;     // average speed on the way to and from a station
  var SKIP_KM = 3;         // a station this close to where we just charged doesn't count as progress
  var PLUG_MIN = 5;        // parking, plugging in and paying
  var STOP_PENALTY = 10;   // planning cost of an extra stop beyond its real minutes
  var MAX_STOPS = 12;
  var DC_TYPES = ['CCS2', 'CHAdeMO', 'GBT', 'Tesla'];

  function km(a, b) {
    var x = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180) * 111.32, y = (b.lat - a.lat) * 110.57;
    return Math.sqrt(x * x + y * y);
  }

  function decode(enc) { // Valhalla polyline, precision 6
    var idx = 0, lat = 0, lng = 0, out = [];
    while (idx < enc.length) {
      for (var k = 0; k < 2; k++) {
        var res = 0, sh = 0, b;
        do { b = enc.charCodeAt(idx++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        var d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lng += d;
      }
      out.push([lat / 1e6, lng / 1e6]);
    }
    return out;
  }

  // Energy per km relative to the car's rated mixed-driving figure. Air drag makes highway
  // speeds cost noticeably more; slow traffic costs a little less.
  var SPEED_CURVE = [[0, 0.95], [50, 0.9], [80, 1.0], [100, 1.12], [120, 1.3], [140, 1.5]];
  function speedFactor(kmh) {
    var c = SPEED_CURVE;
    if (kmh <= c[0][0]) return c[0][1];
    for (var i = 1; i < c.length; i++) {
      if (kmh <= c[i][0]) return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * (kmh - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
    }
    return c[c.length - 1][1];
  }

  // Shape points of one or more Valhalla legs, with cumulative distance (km), time (min) and
  // "rated km" (distance weighted by speedFactor) at each point.
  function profile(legs) {
    var pts = [], cum = [0], eu = [0], tm = [0], legEnds = [];
    legs.forEach(function (leg) {
      var p = decode(leg.shape);
      var speed = new Array(p.length).fill(leg.summary.length / Math.max(leg.summary.time / 3600, 1e-6));
      (leg.maneuvers || []).forEach(function (m) {
        if (!m.time || !m.length) return;
        var v = m.length / (m.time / 3600);
        for (var i = m.begin_shape_index; i < m.end_shape_index && i < p.length; i++) speed[i] = v;
      });
      var base = pts.length;
      p.forEach(function (pt, i) {
        if (base && i === 0) return; // legs share their joining point
        if (pts.length) {
          var prev = pts[pts.length - 1];
          var d = km({ lat: prev[0], lng: prev[1] }, { lat: pt[0], lng: pt[1] });
          var v = speed[Math.max(0, i - 1)] || 60;
          cum.push(cum[cum.length - 1] + d);
          eu.push(eu[eu.length - 1] + d * speedFactor(v));
          tm.push(tm[tm.length - 1] + d / Math.max(v, 5) * 60);
        }
        pts.push(pt);
      });
      legEnds.push(pts.length - 1);
    });
    return { pts: pts, cum: cum, eu: eu, tm: tm, legEnds: legEnds, km: cum[cum.length - 1], min: tm[tm.length - 1] };
  }

  // Interpolate a cumulative array at a distance along the route.
  function at(prof, arr, along) {
    var c = prof.cum, lo = 0, hi = c.length - 1;
    if (along <= 0) return arr[0];
    if (along >= c[hi]) return arr[hi];
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (c[mid] <= along) lo = mid; else hi = mid; }
    var span = c[hi] - c[lo];
    return arr[lo] + (span ? (arr[hi] - arr[lo]) * (along - c[lo]) / span : 0);
  }

  // Distance from p to the route (or to shape points from..to of it), and how far along the
  // route that closest point is (km).
  function nearest(pts, cum, p, from, to) {
    var best = { d: Infinity, along: 0 };
    var kx = Math.cos(p.lat * Math.PI / 180) * 111.32, ky = 110.57;
    for (var i = (from || 0) + 1; i <= (to == null ? pts.length - 1 : to); i++) {
      var ax = (pts[i - 1][1] - p.lng) * kx, ay = (pts[i - 1][0] - p.lat) * ky;
      var bx = (pts[i][1] - p.lng) * kx, by = (pts[i][0] - p.lat) * ky;
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      var cx = ax + t * dx, cy = ay + t * dy, d = Math.sqrt(cx * cx + cy * cy);
      if (d < best.d) best = { d: d, along: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
    }
    return best;
  }

  // Fastest DC plug this car can use at a station, or null.
  function usable(st, car) {
    var best = null;
    (st.plugs || []).forEach(function (p) {
      if (!p.dc || DC_TYPES.indexOf(p.type) < 0) return;
      // Superchargers are treated as Tesla-only: not every Thai site is open to other brands.
      if (p.type === 'Tesla' ? car.brand !== 'Tesla' : car.plugs.indexOf(p.type) < 0) return;
      if (!best || p.kw > best.kw) best = p;
    });
    return best;
  }

  // Stations near the route that this car can fast-charge at, ordered along the route.
  function candidates(prof, stations, car, opts) {
    opts = opts || {};
    var maxOff = opts.maxOff || MAX_OFF_KM;
    var lats = prof.pts.map(function (p) { return p[0]; }), lngs = prof.pts.map(function (p) { return p[1]; });
    var pad = maxOff / 100;
    var box = { s: Math.min.apply(null, lats) - pad, n: Math.max.apply(null, lats) + pad, w: Math.min.apply(null, lngs) - pad, e: Math.max.apply(null, lngs) + pad };
    var out = [];
    stations.forEach(function (st) {
      if (!(st.lat > box.s && st.lat < box.n && st.lng > box.w && st.lng < box.e)) return;
      if (opts.exclude && opts.exclude[st.id]) return;
      if (st.guess && opts.noGuess) return;
      var plug = usable(st, car);
      if (!plug) return;
      // Leg by leg, so on a round trip a station is a candidate on the way out and on the way back.
      var from = 0;
      (prof.legEnds || [prof.pts.length - 1]).forEach(function (end) {
        var n = nearest(prof.pts, prof.cum, st, from, end);
        from = end;
        if (n.d > maxOff) return;
        var detourKm = n.d < 0.15 ? 0 : n.d * 2 * ROAD_FACTOR;
        out.push({ st: st, plug: plug, kw: Math.min(plug.kw || 50, car.dc), along: n.along, off: n.d, detourKm: detourKm, detourMin: detourKm / DETOUR_KMH * 60 });
      });
    });
    return out.sort(function (a, b) { return a.along - b.along; });
  }

  // Charging slows down as the battery fills.
  function taper(soc) {
    if (soc < 50) return 1;
    if (soc < 80) return 1 - (soc - 50) / 30 * 0.45;
    return 0.55 - (soc - 80) / 20 * 0.35;
  }

  // Minutes to charge from one state of charge (%) to another.
  function chargeMinutes(from, to, kw, kwh) {
    if (to <= from || kw <= 0) return 0;
    var min = 0;
    for (var s = Math.floor(from); s < Math.ceil(to); s++) {
      var step = Math.min(s + 1, to) - Math.max(s, from);
      min += kwh * step / 100 / (kw * taper(s) * 0.92) * 60;
    }
    return min;
  }

  // kWh used driving between two points along the route, plus an optional detour (km at rated use).
  function energy(prof, car, from, to, extraKm) {
    var rated = at(prof, prof.eu, to) - at(prof, prof.eu, from) + (extraKm || 0);
    return rated * car.use / 100 * (1 + (car.margin || 0) / 100);
  }

  // Fastest set of stops from start to end (dynamic programming over stations in route order).
  // At each stop the car charges only as much as the next hop needs (plus a small buffer), never
  // past targetSoc; each stop also costs PLUG_MIN plus STOP_PENALTY so fewer stops win close calls.
  // o.pinned: station ids the plan must use (kept in route order).
  function plan(prof, cands, car, o) {
    var cap = car.kwh, minSoc = o.minSoc, target = o.targetSoc;
    var start = { along: 0, kw: 0, detourKm: 0, detourMin: 0, start: true };
    var end = { along: prof.km, kw: 0, detourKm: 0, detourMin: 0, end: true };
    var nodes = [start].concat(cands, [end]);
    var res = { stops: [], ok: true, km: prof.km, driveMin: prof.min };
    if (o.startSoc <= minSoc) { res.ok = false; res.fail = { along: 0, reach: 0, reason: 'start' }; return res; }

    var pinned = (o.pinned || []).map(function (id) {
      for (var i = 1; i < nodes.length - 1; i++) if (nodes[i].st.id === id) return i;
      return -1;
    }).filter(function (i) { return i > 0; }).sort(function (a, b) { return a - b; });
    var gates = [0].concat(pinned, [nodes.length - 1]);

    var pct = function (kwh) { return kwh / cap * 100; };
    var hopKwh = function (a, b) { return energy(prof, car, a.along, b.along, a.detourKm / 2 + b.detourKm / 2); };
    var hopMin = function (a, b) { return at(prof, prof.tm, b.along) - at(prof, prof.tm, a.along) + a.detourMin / 2 + b.detourMin / 2; };

    // Leaving node a for node b, having arrived at a with `arrive` %: returns how much to charge, or null.
    function hop(a, arrive, b) {
      if (!b.end && b.along - a.along < SKIP_KM) return null;
      var need = minSoc + pct(hopKwh(a, b)) + (b.end ? 0 : 2);
      if (a.start) return need <= arrive ? { depart: arrive, min: 0 } : null;
      if (need > target) return null;
      if (need <= arrive + 1) return null; // no need to stop here: going straight past is better
      var depart = Math.max(need, arrive);
      return { depart: depart, min: chargeMinutes(arrive, depart, a.kw, cap) + PLUG_MIN + STOP_PENALTY };
    }

    var best = nodes.map(function () { return null; }); // { time, arrive, prev, depart }
    best[0] = { time: 0, arrive: o.startSoc, prev: -1 };
    for (var g = 0; g + 1 < gates.length; g++) {
      var from = gates[g], to = gates[g + 1];
      if (!best[from]) break;
      // Each segment starts at a pinned station (or the start), so predecessors begin at `from`.
      for (var i = from + 1; i <= to; i++) {
        if (i < to && pinned.indexOf(i) >= 0) continue;
        var bi = null;
        for (var j = from; j < i; j++) {
          var bj = best[j];
          if (!bj || (j > from && pinned.indexOf(j) >= 0)) continue;
          var h = hop(nodes[j], bj.arrive, nodes[i]);
          if (!h) continue;
          var t = bj.time + h.min + hopMin(nodes[j], nodes[i]);
          var arrive = h.depart - pct(hopKwh(nodes[j], nodes[i]));
          if (!bi || t < bi.time - 0.01 || (Math.abs(t - bi.time) <= 0.01 && arrive > bi.arrive)) bi = { time: t, arrive: arrive, prev: j, depart: h.depart, chargeMin: h.min };
        }
        best[i] = bi;
      }
    }

    var last = nodes.length - 1;
    if (!best[last]) {
      // Report the furthest point we could get to.
      var far = 0;
      best.forEach(function (b, i) { if (b && nodes[i].along >= nodes[far].along) far = i; });
      var n = nodes[far], soc = n.start ? o.startSoc : Math.max(best[far].arrive, target);
      res.ok = false;
      res.fail = { along: n.along, reach: n.along + (soc - minSoc) / 100 * cap / (car.use / 100 * (1 + (car.margin || 0) / 100)), soc: soc, at: n.st || null };
      return res;
    }

    var path = [];
    for (var p = last; p > 0; p = best[p].prev) path.unshift(p);
    var prevDepart = o.startSoc, prevNode = start;
    path.forEach(function (idx, k) {
      var next = nodes[path[k + 1]];
      if (!next) return;
      var c = nodes[idx];
      var b = best[path[k + 1]];
      var arrive = best[idx].arrive;
      var chargeMin = chargeMinutes(arrive, b.depart, c.kw, cap);
      res.stops.push({
        c: c, st: c.st, along: c.along, arrive: arrive, depart: b.depart,
        chargeMin: chargeMin, totalMin: chargeMin + PLUG_MIN + c.detourMin,
        kwhAdded: (b.depart - arrive) / 100 * cap,
        pinned: (o.pinned || []).indexOf(c.st.id) >= 0,
        // The previous stop could charge more to reach an alternative further on.
        alts: alternatives(c, prevNode, prevNode.start ? o.startSoc : target, next),
      });
      prevDepart = b.depart;
      prevNode = c;
    });
    res.arrive = best[last].arrive;
    res.chargeMin = res.stops.reduce(function (s, x) { return s + x.totalMin; }, 0);
    return res;

    // Other stations the user could pick instead of stop c, reachable from the previous stop.
    function alternatives(c, prev, prevDepart, next) {
      return cands.filter(function (a) {
        if (a === c || Math.abs(a.along - c.along) > 80 || a.along <= prev.along || a.along >= next.along) return false;
        var arrive = prevDepart - pct(hopKwh(prev, a));
        a._arrive = arrive;
        return arrive >= minSoc; // a replan may add a stop after it if needed
      }).sort(function (x, y) {
        return (y.kw - x.kw) || (x.detourKm - y.detourKm) || (y.along - x.along);
      }).slice(0, 5).map(function (a) { return { c: a, arrive: a._arrive }; });
    }
  }

  // After routing through the chosen stations, recompute battery levels leg by leg on the real route.
  // departs[i] is the charge level when leaving the end of leg i, or null where the car doesn't charge.
  function replay(prof, car, startSoc, departs) {
    var soc = startSoc, out = [], prev = 0;
    prof.legEnds.forEach(function (end, i) {
      var to = prof.cum[end];
      soc -= energy(prof, car, prev, to, 0) / car.kwh * 100;
      out.push({ km: to, arrive: soc });
      if (departs[i] != null) soc = Math.max(soc, departs[i]);
      prev = to;
    });
    return out;
  }

  // Remaining range in km to state of charge in %, using the car's rated use with the safety margin.
  function kmToSoc(rangeKm, car) {
    return Math.max(0, Math.min(100, rangeKm * car.use / 100 * (1 + (car.margin || 0) / 100) / car.kwh * 100));
  }

  var api = {
    km: km, decode: decode, speedFactor: speedFactor, profile: profile, at: at, nearest: nearest,
    usable: usable, candidates: candidates, taper: taper, chargeMinutes: chargeMinutes, energy: energy,
    plan: plan, replay: replay, kmToSoc: kmToSoc, PLUG_MIN: PLUG_MIN, MAX_OFF_KM: MAX_OFF_KM,
  };
  root.EVPlan = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
