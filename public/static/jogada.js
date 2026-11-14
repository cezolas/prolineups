// 2D replay of a whole round (a team's bombsite entry): 10 players, grenades, kills and the plant.
(() => {
  const root = document.getElementById("play"); if (!root) return;
  const cv = root.querySelector("canvas"), ctx = cv.getContext("2d");
  const range = root.querySelector("input[type=range]"), playBtn = root.querySelector("[data-act=play]");
  const out = root.querySelector("[data-out=time]"), feed = root.querySelector("[data-out=feed]");
  const M = JSON.parse(root.dataset.mapdef), ids = JSON.parse(root.dataset.plays);
  const LABELS = JSON.parse(root.dataset.labels || "[]");
  const T = window.I18N || {};
  const css = n => getComputedStyle(document.documentElement).getPropertyValue("--" + n).trim();
  const C = { smoke: css("smoke"), flash: css("flash"), molotov: css("molotov"), he: css("he"), decoy: css("decoy"), T: css("t"), CT: css("ct") };
  const EFF = { smoke: [144, 18], molotov: [120, 7], flash: [60, .35], he: [100, .35], decoy: [30, 2] };
  const k = 1024 / (M.radar_size || 1024);
  const px = (x, y) => [(x - M.pos_x) / M.scale * k, (M.pos_y - y) / M.scale * k];
  const radar = new Image(); radar.src = `/static/radars/${root.dataset.map}.webp`;
  let D = null, t = 0, playing = false, last = 0, speed = 1, view = [0, 0, 1024], cur = null;
  const LEAD = 25 * 64; // start the playhead 25 s before the plant (the whole round is on the slider)

  async function load(id) {
    cur = id;
    D = await (await fetch(`/dados/jogadas/${id}.json`)).json();
    const pts = [px(D.plant_pos[0], D.plant_pos[1])];
    // frame the entry itself: attackers alive in the last 12 s before the plant
    D.frames.forEach(([tk, ps]) => { if (tk >= D.plant - 12 * 64 && tk <= D.plant) ps.forEach(p => { if (p[5] && p[4]) pts.push(px(p[1], p[2])); }); });
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const size = Math.min(1024, Math.max(420, Math.max(...xs) - Math.min(...xs) + 200, Math.max(...ys) - Math.min(...ys) + 200));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    view = [Math.min(Math.max(cx - size / 2, 0), 1024 - size), Math.min(Math.max(cy - size / 2, 0), 1024 - size), size];
    t = Math.max(D.t0, D.plant - LEAD); range.min = D.t0; range.max = D.t1; range.value = t;
    document.querySelectorAll("[data-play]").forEach(b => b.classList.toggle("on", b.dataset.play === id));
    showPov(document.querySelector(`[data-play="${id}"]`));
    draw();
  }

  function frameAt(tt) {
    const f = D.frames; if (!f.length) return [];
    let i = f.findIndex(fr => fr[0] > tt); if (i === -1) i = f.length;
    const a = f[Math.max(0, i - 1)], b = f[Math.min(f.length - 1, i)];
    const w = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (tt - a[0]) / (b[0] - a[0])));
    const bm = new Map(b[1].map(p => [p[0], p]));
    return a[1].map(p => { const q = bm.get(p[0]) || p; return [p[0], p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w, p[3], p[4], p[5]]; });
  }

  // POV video of the entry player for the selected round (recorded with the grenade clips)
  const pov = document.getElementById("pov"), video = pov && pov.querySelector("video");
  function showPov(item) {
    if (!pov) return;
    const src = item && item.dataset.clip;
    pov.hidden = !src;
    if (!src) { video.removeAttribute("src"); video.load(); return; }
    if (video.getAttribute("src") !== src) {
      video.src = src; if (item.dataset.poster) video.poster = item.dataset.poster;
      const cap = pov.querySelector("figcaption"); cap.textContent = cap.dataset.povCaption.replace("{p}", item.dataset.pov || "");
    }
  }

  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  function draw() {
    const [vx, vy, vs] = view, s = cv.width / vs, lw = 1 / s;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, -vx * s, -vy * s);
    if (radar.complete) ctx.drawImage(radar, 0, 0, 1024, 1024);
    ctx.font = `600 ${14.4 * lw}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round"; ctx.lineWidth = 3.5 * lw; ctx.strokeStyle = "rgba(11,13,17,.9)"; ctx.fillStyle = "rgba(233,236,241,.75)";
    for (const [name, x, y] of LABELS) {
      if (x < vx || x > vx + vs || y < vy || y > vy + vs) continue;
      ctx.strokeText(name, x, y); ctx.fillText(name, x, y);
    }
    if (!D) return;
    // grenades
    for (const n of D.nades) {
      if (t < n.t) continue;
      const [r, dur] = EFF[n.type] || [40, 1], end = n.d + dur * 64;
      if (t > end + 64) continue;
      if (t < n.d) {
        ctx.strokeStyle = C[n.type]; ctx.globalAlpha = .8; ctx.lineWidth = 3.5 * lw; ctx.beginPath(); let head = null;
        for (const [tk, x, y] of n.traj) { if (tk > t) break; const [a, b] = px(x, y); head ? ctx.lineTo(a, b) : ctx.moveTo(a, b); head = [a, b]; }
        ctx.stroke(); ctx.globalAlpha = 1;
        if (head) { ctx.fillStyle = C[n.type]; ctx.beginPath(); ctx.arc(head[0], head[1], 7 * lw, 0, 7); ctx.fill(); }
      } else if (t <= end) {
        const [a, b] = px(n.land[0], n.land[1]), life = (t - n.d) / (dur * 64);
        ctx.globalAlpha = n.type === "smoke" ? .55 : n.type === "molotov" ? .45 : 1 - life;
        ctx.fillStyle = C[n.type]; ctx.beginPath();
        ctx.arc(a, b, r / M.scale * k * (n.type === "flash" || n.type === "he" ? .5 + life * .5 : 1), 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // bomb
    if (t >= D.plant) {
      const [a, b] = px(D.plant_pos[0], D.plant_pos[1]), pulse = .5 + .5 * Math.sin((t - D.plant) / 64 * Math.PI * 2);
      ctx.fillStyle = `rgba(224,96,90,${.25 + .25 * pulse})`; ctx.beginPath(); ctx.arc(a, b, 24 * lw, 0, 7); ctx.fill();
      ctx.fillStyle = "#e0605a"; ctx.beginPath(); ctx.arc(a, b, 11 * lw, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = `700 ${11 * lw}px system-ui`; ctx.fillText("C4", a, b + .5 * lw);
    }
    // deaths
    ctx.font = `700 ${22 * lw}px system-ui`;
    for (const kl of D.kills) {
      if (t < kl.t) continue;
      const [a, b] = px(kl.pos[0], kl.pos[1]);
      ctx.globalAlpha = t - kl.t < 128 ? 1 : .45; ctx.fillStyle = "#e0605a"; ctx.fillText("✕", a, b); ctx.globalAlpha = 1;
    }
    // players
    ctx.font = `600 ${19 * lw}px system-ui`;
    for (const p of frameAt(t)) {
      if (!p[4]) continue;
      const [x, y] = px(p[1], p[2]), side = p[5] ? "T" : "CT";
      const a = -p[3] * Math.PI / 180, r = 13 * lw;
      ctx.fillStyle = C[side]; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 1.8, y + Math.sin(a) * r * 1.8);
      ctx.arc(x, y, r, a + .6, a - .6 + Math.PI * 2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "#000"; ctx.lineWidth = 2 * lw; ctx.stroke();
      ctx.lineWidth = 4 * lw; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.fillStyle = "#fff";
      ctx.strokeText(D.players[p[0]] || "", x, y - r * 1.8); ctx.fillText(D.players[p[0]] || "", x, y - r * 1.8);
    }
    // time + kill feed
    const sec = (t - D.plant) / 64;
    out.textContent = `${clock(Math.max(0, (t - D.t0) / 64))} · ` +
      (sec < 0 ? (T.plant_in || "plant em {s}s").replace("{s}", (-sec).toFixed(1)) : (T.plant_after || "plant +{s}s").replace("{s}", sec.toFixed(1)));
    const recent = D.kills.filter(kl => kl.t <= t && t - kl.t < 5 * 64).slice(-4);
    feed.innerHTML = recent.map(kl => `<div>${esc(D.players[kl.a] ?? "?")} <span>✕</span> ${esc(D.players[kl.v] ?? "?")}</div>`).join("");
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function loop(ts) {
    if (playing && D) {
      t += (last ? (ts - last) / 1000 : 0) * 64 * speed;
      if (t >= D.t1) { t = D.t1; playing = false; playBtn.textContent = "↺"; }
      range.value = t; draw();
    }
    last = ts; requestAnimationFrame(loop);
  }
  playBtn.onclick = () => { if (!D) return; if (t >= D.t1) t = Math.max(D.t0, D.plant - LEAD); playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶"; };
  range.oninput = () => { t = +range.value; draw(); };
  root.querySelectorAll("[data-speed]").forEach(b => b.onclick = () => {
    speed = +b.dataset.speed; root.querySelectorAll("[data-speed]").forEach(x => x.classList.toggle("on", x === b));
  });
  root.querySelector("[data-act=start]").onclick = () => { if (D) { t = D.t0; range.value = t; draw(); } };
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-play]"); if (!b) return;
    load(b.dataset.play).then(() => { playing = true; playBtn.textContent = "❚❚"; if (innerWidth < 900) root.scrollIntoView({ behavior: "smooth", block: "start" }); });
  });
  radar.onload = draw;
  load(ids[0]); requestAnimationFrame(loop);
})();
