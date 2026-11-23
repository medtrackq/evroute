// draws the trip line behind the dots, then flags window.__ready for the screenshot script
(async () => {
  await document.fonts.ready;
  await Promise.all(['400','500','600','700','800'].map(w => document.fonts.load(w + ' 40px "Noto Sans Thai"', 'กขค')));
  await Promise.all(['500','600','700','800'].map(w => document.fonts.load(w + ' 40px Inter', 'EV0')));
  await document.fonts.ready;
  document.querySelectorAll('.route').forEach(r => {
    const d = r.querySelectorAll('.dot'); if (d.length < 2) return;
    const rr = r.getBoundingClientRect(), a = d[0].getBoundingClientRect(), b = d[d.length - 1].getBoundingClientRect();
    const line = document.createElement('div'); line.className = 'rline';
    line.style.left = (a.left + a.width / 2 - rr.left - 3) + 'px';
    line.style.top = (a.top + a.height / 2 - rr.top) + 'px';
    line.style.height = (b.top - a.top) + 'px';
    r.prepend(line);
  });
  window.__ready = true;
})();
