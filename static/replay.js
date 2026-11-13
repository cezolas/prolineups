// 2D replay of one use of a lineup: a few seconds of the round around the throw.
(() => {
  const root = document.getElementById("replay"); if (!root) return;
  const cv = root.querySelector("canvas"), ctx = cv.getContext("2d");
  const range = root.querySelector("input[type=range]"), playBtn = root.querySelector("[data-act=play]");
  const out = root.querySelector("[data-out=time]");
  const M = JSON.parse(root.dataset.mapdef), uses = JSON.parse(root.dataset.uses);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue("--" + n).trim();
  const C = { smoke: css("smoke"), flash: css("flash"), molotov: css("molotov"), he: css("he"), decoy: css("decoy"), T: css("t"), CT: css("ct") };
  const EFF = { smoke: [144, 18], molotov: [120, 7], flash: [60, .35], he: [100, .35], decoy: [30, 2] };
  const k = 1024 / (M.radar_size || 1024);
  const px = (x, y) => [(x - M.pos_x) / M.scale * k, (M.pos_y - y) / M.scale * k];
  const radar = new Image(); radar.src = `/static/radars/${root.dataset.map}.webp`;
  let D = null, t = 0, playing = false, last = 0, view = [0, 0, 1024];

  async function load(id) {
    D = await (await fetch(`/dados/usos/${id}.json`)).json();
    // zoom on the area where things happen
    const pts = [];
    D.nades.filter(n => n.main).forEach(n => n.traj.forEach(([, x, y]) => pts.push(px(x, y))));
    D.frames.forEach(([, ps]) => ps.forEach(p => { if (p[0] === D.thrower) pts.push(px(p[1], p[2])); }));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const size = Math.min(1024, Math.max(320, Math.max(...xs) - Math.min(...xs) + 220, Math.max(...ys) - Math.min(...ys) + 220));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    view = [Math.min(Math.max(cx - size / 2, 0), 1024 - size), Math.min(Math.max(cy - size / 2, 0), 1024 - size), size];
    t = D.t0; range.min = D.t0; range.max = D.t1; range.value = t;
    document.querySelectorAll("[data-use]").forEach(b => b.closest("tr")?.classList.toggle("on", b.dataset.use === id));
    draw();
  }

  function frameAt(tt) {
    const f = D.frames; if (!f.length) return [];
    let i = f.findIndex(fr => fr[0] > tt); if (i === -1) i = f.length; const a = f[Math.max(0, i - 1)], b = f[Math.min(f.length - 1, i)];
    const w = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (tt - a[0]) / (b[0] - a[0])));
    const bm = new Map(b[1].map(p => [p[0], p]));
    return a[1].map(p => { const q = bm.get(p[0]) || p; return [p[0], p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w, p[3], p[4], p[5]]; });
  }

  function draw() {
    const [vx, vy, vs] = view, s = cv.width / vs;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, -vx * s, -vy * s);
    if (radar.complete) ctx.drawImage(radar, 0, 0, 1024, 1024);
    if (!D) return;
    const lw = 1 / s;
    for (const n of D.nades) {
      if (t < n.t) continue;
      const [r, dur] = EFF[n.type] || [40, 1], end = n.d + dur * 64;
      if (t > end && !n.main) continue;
      ctx.strokeStyle = C[n.type]; ctx.globalAlpha = n.main ? 1 : .55; ctx.lineWidth = (n.main ? 3.5 : 2) * lw * 1.4;
      ctx.beginPath(); let head = null;
      for (const [tk, x, y] of n.traj) { if (tk > t) break; const [a, b] = px(x, y); head ? ctx.lineTo(a, b) : ctx.moveTo(a, b); head = [a, b]; }
      ctx.stroke(); ctx.globalAlpha = 1;
      if (t < n.d && head) { ctx.fillStyle = C[n.type]; ctx.beginPath(); ctx.arc(head[0], head[1], 6 * lw * 1.4, 0, 7); ctx.fill(); }
      if (t >= n.d && t <= end) {
        const [a, b] = px(n.land[0], n.land[1]), life = (t - n.d) / (dur * 64);
        ctx.globalAlpha = n.type === "smoke" ? .5 : n.type === "molotov" ? .4 : 1 - life;
        ctx.fillStyle = C[n.type]; ctx.beginPath(); ctx.arc(a, b, r / M.scale * k * (n.type === "flash" || n.type === "he" ? .5 + life * .5 : 1), 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.font = `${13 * lw * 1.3}px system-ui`; ctx.textAlign = "center";
    for (const p of frameAt(t)) {
      const [x, y] = px(p[1], p[2]), side = p[5] ? "T" : "CT";
      if (!p[4]) { ctx.globalAlpha = .4; ctx.fillStyle = C[side]; ctx.fillText("✕", x, y + 4 * lw); ctx.globalAlpha = 1; continue; }
      const a = -p[3] * Math.PI / 180, r = (p[0] === D.thrower ? 10 : 8) * lw * 1.3;
      ctx.fillStyle = C[side]; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 1.8, y + Math.sin(a) * r * 1.8);
      ctx.arc(x, y, r, a + .6, a - .6 + Math.PI * 2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = p[0] === D.thrower ? "#fff" : "#000"; ctx.lineWidth = 2 * lw * 1.3; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.fillText(D.players[p[0]] || "", x, y - r * 1.7);
    }
    const sec = (t - D.throw) / 64;
    out.textContent = sec < 0 ? `lança em ${(-sec).toFixed(1)}s` : `+${sec.toFixed(1)}s`;
  }

  function loop(ts) {
    if (playing && D) {
      t += (last ? (ts - last) / 1000 : 0) * 64;
      if (t >= D.t1) { t = D.t1; playing = false; playBtn.textContent = "↺"; }
      range.value = t; draw();
    }
    last = ts; requestAnimationFrame(loop);
  }
  playBtn.onclick = () => { if (!D) return; if (t >= D.t1) t = D.t0; playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶"; };
  range.oninput = () => { t = +range.value; draw(); };
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-use]"); if (!b) return;
    load(b.dataset.use).then(() => { playing = true; playBtn.textContent = "❚❚"; root.scrollIntoView({ behavior: "smooth", block: "center" }); });
  });
  radar.onload = draw;
  load(uses[0]); requestAnimationFrame(loop);
})();
