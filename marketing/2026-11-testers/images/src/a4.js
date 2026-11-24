// builds the 2 × 5 grid + crop marks (before card.js runs, so card.js fills the cards)
(() => {
  const side = document.body.dataset.side;
  const grid = document.querySelector('.grid');
  grid.innerHTML = Array.from({ length: 10 }, () => `<div class="slot"><div class="ec" data-side="${side}"></div></div>`).join('');
  const X = [15, 105, 195], Y = [11, 66, 121, 176, 231, 286], GAP = 2, LEN = 5; // mm
  let l = '';
  for (const x of X) l += `<line x1="${x}" y1="${Y[0] - GAP - LEN}" x2="${x}" y2="${Y[0] - GAP}"/><line x1="${x}" y1="${Y[5] + GAP}" x2="${x}" y2="${Y[5] + GAP + LEN}"/>`;
  for (const y of Y) l += `<line x1="${X[0] - GAP - LEN}" y1="${y}" x2="${X[0] - GAP}" y2="${y}"/><line x1="${X[2] + GAP}" y1="${y}" x2="${X[2] + GAP + LEN}" y2="${y}"/>`;
  document.querySelector('.marks').innerHTML = l;
})();
