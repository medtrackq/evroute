// Who has the app open right now, for the admin page. Each open, visible page pings every two
// minutes with the random per-browser id the statistics use (lib/stats.mjs dev); ids are kept in
// memory only, never stored, and forgotten after WINDOW. Also the day's peak (Bangkok day).
const DEV = /^d-[a-z0-9]{8}$/;

export function liveCounter({ windowMs = 5 * 60 * 1000, max = 50000, now = () => Date.now() } = {}) {
  const seen = new Map(); // dev -> last ping; kept in ping order, oldest first
  let peak = { day: '', n: 0, at: null };
  const bkkDay = (t) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
  const prune = (t) => { for (const [k, v] of seen) { if (t - v <= windowMs) break; seen.delete(k); } };

  return {
    ping(dev) {
      if (typeof dev !== 'string' || !DEV.test(dev)) return false;
      const t = now();
      seen.delete(dev);
      seen.set(dev, t);
      if (seen.size > max) seen.delete(seen.keys().next().value);
      prune(t);
      const day = bkkDay(t);
      if (peak.day !== day) peak = { day, n: 0, at: null };
      if (seen.size > peak.n) peak = { day, n: seen.size, at: new Date(t).toISOString() };
      return true;
    },
    // { n: open now, peak: most at once today, peakAt }
    count() {
      const t = now();
      prune(t);
      const today = peak.day === bkkDay(t);
      return { n: seen.size, peak: today ? peak.n : seen.size, peakAt: today ? peak.at : null };
    },
  };
}
