// fills every <div class="ec" data-side="front|back"> with the card, then flags window.__ready for render.cjs
// text = marketing/facts.md "แอปทำอะไรได้จริง" + slogan · no numbers on the card · QR from qr-data.js (make-qr.cjs)
(() => {
  const Q = window.EVQR;
  const qr = px => `<svg class="qr" viewBox="0 0 ${Q.total} ${Q.total}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="${Q.text}"><rect width="${Q.total}" height="${Q.total}" fill="#fff"/><path fill="#121826" d="${Q.d}"/></svg>`;
  const mark = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5 12 3l8 4.5-8 4.5z"/><path d="M4 12l8 4.5 8-4.5" opacity=".75"/><path d="M4 16.5 12 21l8-4.5" opacity=".5"/></svg>';
  const logo = `<div class="logo">${mark}<span class="name"><b>EV</b>ROUTE</span></div>`;
  const ico = {
    bolt: '<svg viewBox="0 0 24 24"><path d="M13.5 2.5 5 13.5h6.5l-1 8 8.5-11h-6.5z"/></svg>',
    ahead: '<svg viewBox="0 0 24 24"><path d="M12 21V4M5.5 10.5 12 4l6.5 6.5"/></svg>',
    cup: '<svg viewBox="0 0 24 24"><path d="M4 9.5h12V14a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 11h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5V6M12 3.5V6"/></svg>',
  };

  const front = `<div class="safe">
    <div class="fl">
      ${logo}
      <div class="mid">
        <div class="fh">วางแผนชาร์จ</div>
        <p class="slogan"><b>ไม่ต้องกลัวไฟหมด ไม่อดตาย</b>มี <span class="nw">EVROUTE</span> เป็น<span class="acc">เพื่อนร่วมทาง</span></p>
      </div>
      <div class="trk" aria-hidden="true"><i></i><span class="a"></span><span class="s"><svg viewBox="0 0 24 24"><path d="M13.5 2 4.5 14h7l-1 8 9-12h-7z"/></svg></span><span class="b"></span></div>
    </div>
    <div class="qrbox">
      ${qr(Q.total * 10)}
      <div class="url">evroute.info</div>
      <div class="free">ฟรี ไม่ต้องสมัคร</div>
    </div>
  </div>`;

  const back = `<div class="safe">
    <div class="bh">แวะชาร์จที่ไหน <span class="acc">กี่นาที ค่าไฟเท่าไร</span></div>
    <div class="bmain">
      <ul class="pts">
        <li><span class="dot">${ico.bolt}</span><div><b>บอกจุดแวะชาร์จตลอดทาง</b><small>ชาร์จกี่นาที ค่าไฟประมาณเท่าไร</small></div></li>
        <li><span class="dot">${ico.ahead}</span><div><b>เลือกจุดชาร์จฝั่งขาไป</b><small>ไม่ต้องกลับรถ</small></div></li>
        <li><span class="dot">${ico.cup}</span><div><b>เลือกจุดแวะที่มีข้าว กาแฟ ห้องน้ำ</b><small>ตรงช่วงมื้ออาหาร ไม่อดตาย</small></div></li>
      </ul>
      <div class="side">
        ${qr(Q.total * 6)}
        ${logo}
        <div class="url">evroute.info</div>
      </div>
    </div>
    <div class="beta">อยู่ระหว่างทดลอง ติชมได้ในแอป: <span class="tag">ติดต่อเรา / แจ้งปัญหา</span></div>
  </div>`;

  document.querySelectorAll('.ec[data-side]').forEach(el => {
    el.classList.add(el.dataset.side);
    el.innerHTML = el.dataset.side === 'front' ? front : back;
  });

  (async () => {
    await document.fonts.ready;
    await Promise.all(['400', '500', '600', '700', '800'].map(w => document.fonts.load(w + ' 40px "Noto Sans Thai"', 'กขค')));
    await Promise.all(['400', '600', '700', '800'].map(w => document.fonts.load(w + ' 40px Inter', 'EV0')));
    await document.fonts.ready;
    window.__ready = true;
  })();
})();
