// "Demo review in 2D": replays any round of the player's demo on the radar (players, grenades, kills, bomb).
// The demo is parsed in this browser by compare-worker.js (nothing is uploaded); positions are read per round on
// demand (8 samples per second) and interpolated. compare.js calls window.PNReview.load(...) after its analysis.
(() => {
  const box = document.getElementById("cmpReview"); if (!box) return;
  const S = JSON.parse(document.getElementById("cmp").dataset.i18n);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue("--" + n).trim();
  const C = { smoke: css("smoke") || "#ccc", flash: css("flash") || "#ff0", molotov: css("molotov") || "#f60", he: css("he") || "#f44",
              T: css("t") || "#e6a23c", CT: css("ct") || "#5aa9e6" };
  const THROWN = { smokegrenade: "smoke", flashbang: "flash", hegrenade: "he", molotov: "molotov", incgrenade: "molotov" };
  const DET = { smokegrenade_detonate: "smoke", flashbang_detonate: "flash", hegrenade_detonate: "he", inferno_startburn: "molotov" };
  const EFF = { smoke: [144, 18], molotov: [120, 7], flash: [60, .35], he: [100, .35] };   // radius (units), seconds
  const STEP = 8;   // ticks between position samples (8 per second)
  let W = null, EV = [], M = null, ROUNDS = [], ME = "", cur = null, t = 0, playing = false, speed = 1, last = 0;
  const cache = new Map();
  const cv = document.createElement("canvas"); cv.width = cv.height = 1024;
  const ctx = cv.getContext("2d");
  const radar = new Image();

  const px = (x, y) => [(x - M.pos_x) / M.scale * (1024 / (M.size || 1024)), (M.pos_y - y) / M.scale * (1024 / (M.size || 1024))];
  const clock = (tk, r) => { const s = Math.max(0, Math.floor((tk - r.start) / 64)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  // ---- rounds and their events, from the events compare-worker.js already returned
  function rounds() {
    // the live match starts at the last "match start" event: warmup and knife rounds before it are left out
    const starts = EV.filter((e) => e.event_name === "round_announce_match_start").map((e) => e.tick);
    const live = Math.max(0, ...(starts.length ? starts : EV.filter((e) => e.event_name === "begin_new_match").map((e) => e.tick)));
    const fe = EV.filter((e) => e.event_name === "round_freeze_end" && e.tick >= live).map((e) => e.tick).sort((a, b) => a - b);
    const ends = EV.filter((e) => e.event_name === "round_end").sort((a, b) => a.tick - b.tick);
    const out = [];
    fe.forEach((start, i) => {
      const next = fe[i + 1] ?? Infinity;
      const end = ends.find((e) => e.tick > start && e.tick <= next);
      if (!end) return;
      out.push({ n: out.length + 1, start, end: Math.min(end.tick + 4 * 64, next), endTick: end.tick, winner: end.winner });
    });
    return out;
  }
  function roundEvents(r) {
    const inR = (e) => e.tick >= r.start - 64 && e.tick <= r.end;
    const kills = EV.filter((e) => e.event_name === "player_death" && inR(e)).sort((a, b) => a.tick - b.tick);
    const bomb = EV.filter((e) => /^bomb_(planted|defused|exploded)$/.test(e.event_name) && inR(e));
    const dets = EV.filter((e) => DET[e.event_name] && inR(e)).sort((a, b) => a.tick - b.tick);
    const used = new Set(), nades = [];
    for (const g of EV.filter((e) => e.event_name === "grenade_thrown" && THROWN[e.weapon] && inR(e)).sort((a, b) => a.tick - b.tick)) {
      const type = THROWN[g.weapon];
      const i = dets.findIndex((d, k) => !used.has(k) && DET[d.event_name] === type && String(d.user_steamid) === String(g.user_steamid) && d.tick > g.tick);
      if (i < 0 || g.user_X == null) continue;
      used.add(i);
      nades.push({ type, t: g.tick, d: dets[i].tick, from: [g.user_X, g.user_Y], to: [dets[i].x, dets[i].y], who: g.user_name });
    }
    return { kills, bomb, nades };
  }

  // ---- positions of one round (asked to the worker once, then cached; every request has its own id)
  const pending = new Map(); let rid = 0;
  function onWorker(e) {
    const d = e.data; if (!d || !d.rid || !pending.has(d.rid)) return;
    const { ok, bad, r } = pending.get(d.rid); pending.delete(d.rid);
    if (d.error || !d.replay) { bad(d.error || "?"); return; }
    const by = new Map();
    for (const row of d.replay) {
      if (row.X == null) continue;
      if (!by.has(row.tick)) by.set(row.tick, []);
      by.get(row.tick).push([row.name, row.X, row.Y, row.yaw || 0, row.team_num, row.is_alive]);
    }
    const frames = [...by.entries()].sort((a, b) => a[0] - b[0]);
    cache.set(r.n, frames); ok(frames);
  }
  function positions(r) {
    if (cache.has(r.n)) return Promise.resolve(cache.get(r.n));
    return new Promise((ok, bad) => {
      const ticks = []; for (let tk = r.start; tk <= r.end; tk += STEP) ticks.push(tk);
      const id = ++rid; pending.set(id, { ok, bad, r });
      W.postMessage({ replay: ticks, rid: id });
    });
  }
  function frameAt(frames, tt) {
    if (!frames.length) return [];
    let i = frames.findIndex((f) => f[0] > tt); if (i === -1) i = frames.length;
    const a = frames[Math.max(0, i - 1)], b = frames[Math.min(frames.length - 1, i)];
    const w = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (tt - a[0]) / (b[0] - a[0])));
    const bm = new Map(b[1].map((p) => [p[0], p]));
    return a[1].map((p) => { const q = bm.get(p[0]) || p; return [p[0], p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w, p[3], p[4], p[5]]; });
  }

  // ---- drawing
  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1024, 1024);
    ctx.fillStyle = "#0b0d11"; ctx.fillRect(0, 0, 1024, 1024);
    if (radar.complete && radar.naturalWidth) ctx.drawImage(radar, 0, 0, 1024, 1024);
    if (!cur || !cur.frames) return;
    const { ev, frames, r } = cur;
    for (const n of ev.nades) {   // flight (straight line from where he threw to where it went off) and its effect
      if (t < n.t) continue;
      const [ax, ay] = px(...n.from), [bx, by] = px(...n.to), [rad, dur] = EFF[n.type] || [40, 1], end = n.d + dur * 64;
      if (t < n.d) {
        const w = (t - n.t) / Math.max(1, n.d - n.t), hx = ax + (bx - ax) * w, hy = ay + (by - ay) * w;
        ctx.strokeStyle = C[n.type]; ctx.lineWidth = 2; ctx.globalAlpha = .7;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.globalAlpha = 1; ctx.fillStyle = C[n.type]; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 7); ctx.fill();
      } else if (t <= end) {
        const life = (t - n.d) / (dur * 64), rr = rad / M.scale * (1024 / (M.size || 1024));
        ctx.globalAlpha = n.type === "smoke" ? .55 : n.type === "molotov" ? .45 : 1 - life;
        ctx.fillStyle = C[n.type]; ctx.beginPath(); ctx.arc(bx, by, rr * (n.type === "flash" || n.type === "he" ? .5 + life * .5 : 1), 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    for (const k of ev.kills) {   // where people died (stays on the map)
      if (t < k.tick || k.user_X == null) continue;
      const [x, y] = px(k.user_X, k.user_Y);
      ctx.strokeStyle = k.user_team_num === 2 ? C.T : C.CT; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7); ctx.stroke();
    }
    for (const b of ev.bomb) {
      if (t < b.tick || b.user_X == null) continue;
      const [x, y] = px(b.user_X, b.user_Y);
      ctx.fillStyle = b.event_name === "bomb_defused" ? C.CT : "#ff4d4d";
      ctx.beginPath(); ctx.arc(x, y, 9 + 3 * Math.sin(t / 10), 0, 7); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 12px system-ui"; ctx.textAlign = "center"; ctx.fillText("C4", x, y + 4);
    }
    ctx.font = "600 15px system-ui"; ctx.textAlign = "center";
    for (const p of frameAt(frames, t)) {
      const [x, y] = px(p[1], p[2]), side = p[4] === 2 ? "T" : "CT", me = p[0] === ME;
      if (!p[5]) continue;
      const a = -p[3] * Math.PI / 180, rr = me ? 12 : 10;
      ctx.fillStyle = C[side]; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * rr * 1.8, y + Math.sin(a) * rr * 1.8);
      ctx.arc(x, y, rr, a + .6, a - .6 + Math.PI * 2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = me ? "#fff" : "#000"; ctx.lineWidth = me ? 3 : 2; ctx.stroke();
      ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(11,13,17,.9)"; ctx.strokeText(p[0], x, y - rr - 8);
      ctx.fillStyle = me ? "#fff" : "rgba(233,236,241,.9)"; ctx.fillText(p[0], x, y - rr - 8);
    }
    box.querySelector("[data-rv=time]").textContent = clock(t, r);
    box.querySelector("[data-rv=range]").value = t;
    box.querySelectorAll("[data-seek]").forEach((li) => li.classList.toggle("past", +li.dataset.seek <= t));
  }
  function loop(ts) {
    if (playing && cur && cur.frames) {
      t += (last ? (ts - last) / 1000 : 0) * 64 * speed;
      if (t >= cur.r.end) { t = cur.r.end; playing = false; box.querySelector("[data-rv=play]").textContent = "↺"; }
      draw();
    }
    last = ts; requestAnimationFrame(loop);
  }

  // ---- UI
  function feed(ev, r) {
    const items = [];
    for (const k of ev.kills) items.push([k.tick, `<b class="${k.attacker_team_num === 2 ? "t" : "ct"}">${esc(k.attacker_name || "?")}</b> ${esc(k.weapon || "")}${k.headshot ? " ⊕" : ""} <b class="${k.user_team_num === 2 ? "t" : "ct"}">${esc(k.user_name)}</b>`]);
    for (const b of ev.bomb) items.push([b.tick, `💣 ${esc(S.rv_bomb[b.event_name] || b.event_name)}${b.user_name ? ` · ${esc(b.user_name)}` : ""}`]);
    for (const n of ev.nades) items.push([n.t, `<span class="badge type-${n.type}">${esc(S.types[n.type] || n.type)}</span> ${esc(n.who || "")}`]);
    items.sort((a, b) => a[0] - b[0]);
    return items.map(([tk, html]) => `<li data-seek="${tk}"><span class="muted">${clock(tk, r)}</span> ${html}</li>`).join("");
  }
  async function pick(n) {
    const r = ROUNDS.find((x) => x.n === n); if (!r) return;
    box.querySelectorAll("[data-round]").forEach((b) => b.classList.toggle("on", +b.dataset.round === n));
    playing = false; box.querySelector("[data-rv=play]").textContent = "▶";
    const ev = roundEvents(r);
    cur = { r, ev, frames: null };
    t = r.start;
    const range = box.querySelector("[data-rv=range]"); range.min = r.start; range.max = r.end; range.value = t;
    box.querySelector("[data-rv=feed]").innerHTML = feed(ev, r);
    box.querySelector("[data-rv=msg]").textContent = S.rv_loading;
    draw();
    try {
      const frames = await positions(r);
      if (cur.r !== r) return;
      cur.frames = frames;
      box.querySelector("[data-rv=msg]").textContent = "";
      playing = true; box.querySelector("[data-rv=play]").textContent = "❚❚";
      draw();
    } catch (e) {
      box.querySelector("[data-rv=msg]").textContent = S.rv_error;
    }
  }

  window.PNReview = {
    load({ worker, events, radar: R, player }) {
      if (W) W.removeEventListener("message", onWorker);
      W = worker; EV = events || []; M = R; ME = player || "";
      cache.clear(); pending.clear(); cur = null;
      if (W) W.addEventListener("message", onWorker);
      box.hidden = false;
      if (!W) {   // restored from this browser's memory: the demo itself is gone, ask for it again
        box.innerHTML = `<h2>${esc(S.rv_h)}</h2><p class="muted">${esc(S.rv_again)}</p>`;
        return;
      }
      ROUNDS = rounds();
      if (!ROUNDS.length || !M) { box.hidden = true; return; }
      radar.src = `/static/radars/${M.slug}.webp`;
      const cls = (r) => (r.winner === 2 || r.winner === "T" ? "t" : r.winner === 3 || r.winner === "CT" ? "ct" : "");
      box.innerHTML = `<h2>${esc(S.rv_h)}</h2><p class="muted small">${esc(S.rv_lead)}</p>
        <div class="rv-rounds">${ROUNDS.map((r) => `<button type="button" class="rv-r ${cls(r)}" data-round="${r.n}">${r.n}</button>`).join("")}</div>
        <div class="rv-wrap"><div class="rv-stage"></div>
          <div class="rv-side"><ol class="rv-feed" data-rv="feed"></ol></div></div>
        <div class="rv-ctrl"><button type="button" class="btn small" data-rv="play">▶</button>
          <input type="range" data-rv="range" step="1">
          <span data-rv="time" class="rv-time">0:00</span>
          <select data-rv="speed" aria-label="${esc(S.rv_speed)}"><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option><option value="0.5">0,5x</option></select>
          <span class="muted small" data-rv="msg"></span></div>
        <p class="muted small">${esc(S.rv_help)}</p>`;
      box.querySelector(".rv-stage").appendChild(cv);
      box.querySelector("[data-rv=play]").onclick = () => {
        if (!cur || !cur.frames) return;
        if (t >= cur.r.end) t = cur.r.start;
        playing = !playing; box.querySelector("[data-rv=play]").textContent = playing ? "❚❚" : "▶";
      };
      box.querySelector("[data-rv=range]").oninput = (e) => { t = +e.target.value; draw(); };
      box.querySelector("[data-rv=speed]").onchange = (e) => { speed = +e.target.value; };
      box.querySelector(".rv-rounds").onclick = (e) => { const b = e.target.closest("[data-round]"); if (b) pick(+b.dataset.round); };
      box.querySelector("[data-rv=feed]").onclick = (e) => {
        const li = e.target.closest("[data-seek]"); if (!li || !cur) return;
        t = Math.max(cur.r.start, +li.dataset.seek - 3 * 64); draw();
      };
      radar.onload = draw;
      pick(1);
    },
    player(name) { ME = name || ""; draw(); },
  };
  requestAnimationFrame(loop);
})();
