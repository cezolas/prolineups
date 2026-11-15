// "Compare my demo": the player's demo is parsed in this browser (WebAssembly worker), never uploaded.
// Each of the player's grenades is matched with the pros' lineups by where it was thrown from and where it landed.
(() => {
  const root = document.getElementById("cmp"); if (!root) return;
  const S = JSON.parse(root.dataset.i18n), lang = root.dataset.lang;
  const $ = s => root.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let DATA = null, FLIGHTS = [], MAP = null, EV = [];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] - b[2]) * 0.5);
  const clock = t => { const s = Math.floor(t / 64); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const status = (msg, err) => { const el = $("#cmpStatus"); el.textContent = msg; el.classList.toggle("err", !!err); el.hidden = !msg; };

  $("#cmpFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) read(f); });
  const drop = $("#cmpDrop");
  ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) read(f); });
  $("#cmpPlayer").addEventListener("change", () => { try { localStorage.setItem("cmpPlayer", $("#cmpPlayer").value); } catch (e) {} render(); });

  async function read(file) {
    if (/\.bz2$/i.test(file.name)) { status(S.err_bz2, true); return; }
    $("#cmpOut").innerHTML = ""; $("#cmpPick").hidden = true;
    status(S.reading.replace("{mb}", Math.round(file.size / 1e6)));
    const buf = await file.arrayBuffer();
    const w = new Worker(root.dataset.worker || "/static/compare-worker.js");
    w.onmessage = async e => {
      const d = e.data;
      if (d.stage) { status(S["stage_" + d.stage] || S.reading); return; }
      w.terminate();
      if (d.error) { status(d.error === "bz2" ? S.err_bz2 : S.err_parse.replace("{e}", d.error), true); return; }
      MAP = (d.header && d.header.map_name) || "";
      if (!DATA) DATA = await (await fetch(`/dados/comparar-${lang}.json`)).json();
      if (!DATA.maps[MAP]) { status(S.err_map.replace("{m}", MAP || "?"), true); return; }
      EV = d.events || [];
      FLIGHTS = flights(EV);
      if (!FLIGHTS.length) { status(S.err_none, true); return; }
      status("");
      players();
    };
    w.onerror = () => status(S.err_parse.replace("{e}", "worker"), true);
    w.postMessage({ buf }, [buf]);
  }

  // grenade_thrown (where the player stood) paired with the next detonation of the same type by the same player
  const THROWN = { smokegrenade: "smoke", flashbang: "flash", hegrenade: "he", molotov: "molotov", incgrenade: "molotov" };
  const DET = { smokegrenade_detonate: "smoke", flashbang_detonate: "flash", hegrenade_detonate: "he", inferno_startburn: "molotov" };
  function flights(events) {
    const dets = events.filter(e => DET[e.event_name]).sort((a, b) => a.tick - b.tick);
    const used = new Set(), out = [];
    for (const t of events.filter(e => e.event_name === "grenade_thrown" && THROWN[e.weapon]).sort((a, b) => a.tick - b.tick)) {
      const type = THROWN[t.weapon], sid = String(t.user_steamid);
      const i = dets.findIndex((d, k) => !used.has(k) && DET[d.event_name] === type && String(d.user_steamid) === sid
                                          && d.tick > t.tick && d.tick - t.tick < 20 * 64);
      if (i < 0 || t.user_X == null) continue;
      used.add(i);
      const d = dets[i];
      out.push({ type, tick: t.tick, steamid: sid, name: t.user_name || "?", t: [t.user_X, t.user_Y, t.user_Z], l: [d.x, d.y, d.z] });
    }
    return out;
  }

  function players() {
    const cnt = new Map();
    FLIGHTS.forEach(f => cnt.set(f.name, (cnt.get(f.name) || 0) + 1));
    const names = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
    let saved = null; try { saved = localStorage.getItem("cmpPlayer"); } catch (e) {}
    $("#cmpPlayer").innerHTML = names.map(([n, c]) => `<option value="${esc(n)}">${esc(n)} (${c})</option>`).join("");
    if (saved && cnt.has(saved)) $("#cmpPlayer").value = saved;
    $("#cmpMap").textContent = DATA.maps[MAP].name;
    $("#cmpPick").hidden = false;
    render();
  }

  function match(f) {
    const M = DATA.maps[MAP], eps = DATA.eps[f.type] || DATA.eps.flash;
    let same = null, dest = null;
    for (const l of M.lineups) {
      if (l.type !== f.type) continue;
      const dl = dist(f.l, l.l), dt = dist(f.t, l.p || l.t);
      if (dl > eps.land * 1.25) continue;
      if (dt <= eps.throw * 1.5 && (!same || dt + dl < same.dt + same.dl)) same = { l, dt, dl };
      if (!dest || dl < dest.dl) dest = { l, dt, dl };
    }
    if (same) return { kind: "same", ...same };
    if (dest) return { kind: "dest", ...dest };
    return { kind: "none" };
  }

  function render() {
    const who = $("#cmpPlayer").value;
    const mine = FLIGHTS.filter(f => f.name === who).map(f => ({ f, m: match(f) }));
    const n = k => mine.filter(x => x.m.kind === k).length;
    const typeName = t => S.types[t] || t;
    const card = ({ f, m }) => {
      const head = `<span class="badge type-${f.type}">${esc(typeName(f.type))}</span> <span class="muted small">${clock(f.tick)}</span>`;
      if (m.kind === "same") return `<li class="cm same">${head}<div><b>${esc(S.same_t)}</b> <a href="${m.l.url}">${esc(m.l.name)}</a></div>
        <div class="muted small">${esc(S.same_d.replace("{u}", Math.round(m.dt)))}${m.dt <= 16 ? " ✓" : ""}</div></li>`;
      if (m.kind === "dest") return `<li class="cm dest">${head}<div><b>${esc(S.dest_t)}</b> <a href="${m.l.url}">${esc(m.l.name)}</a></div>
        <div class="muted small">${esc(S.dest_d.replace("{u}", Math.round(m.dt)).replace("{from}", m.l.from || "?"))}</div></li>`;
      return `<li class="cm none">${head}<div><b>${esc(S.none_t)}</b></div><div class="muted small">${esc(S.none_d)}</div></li>`;
    };
    const section = (k, title) => mine.some(x => x.m.kind === k) ? `<section><h2>${esc(title)} (${n(k)})</h2><ul class="cm-list">${mine.filter(x => x.m.kind === k).map(card).join("")}</ul></section>` : "";
    $("#cmpOut").innerHTML = statsBlock(who) + heatBlock(mine) + `
      <div class="kpis">
        <div class="kpi"><div class="kpi-v">${mine.length}</div><div class="kpi-l">${esc(S.k_total)}</div></div>
        <div class="kpi"><div class="kpi-v">${n("same")}</div><div class="kpi-l">${esc(S.k_same)}</div></div>
        <div class="kpi"><div class="kpi-v">${n("dest")}</div><div class="kpi-l">${esc(S.k_dest)}</div></div>
        <div class="kpi"><div class="kpi-v">${n("none")}</div><div class="kpi-l">${esc(S.k_none)}</div></div>
      </div>
      ${section("same", S.sec_same)}${section("dest", S.sec_dest)}${section("none", S.sec_none)}`;
  }

  // ---------------------------------------------------------------- you vs the pros: numbers
  function statsBlock(who) {
    const M = DATA.maps[MAP], pro = M.pro || {};
    const rounds = Math.max(1, EV.filter(e => e.event_name === "round_end").length);
    const deaths = EV.filter(e => e.event_name === "player_death");
    const k = deaths.filter(e => e.attacker_name === who && e.user_name !== who && e.attacker_team_num !== e.user_team_num);
    const dd = deaths.filter(e => e.user_name === who).length;
    const hs = k.filter(e => e.headshot).length;
    const byType = { smoke: 0, flash: 0, molotov: 0, he: 0 };
    EV.filter(e => e.event_name === "grenade_thrown" && e.user_name === who).forEach(e => { const ty = THROWN[e.weapon]; if (ty) byType[ty]++; });
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    const blinds = EV.filter(e => e.event_name === "player_blind" && e.attacker_name === who && e.user_name !== who && (e.blind_duration || 0) > 0);
    const enemyBl = blinds.filter(e => e.attacker_team_num !== e.user_team_num).length;
    // a flash that blinded a teammate for 1 s or more (same rule as the pros' "team flash")
    const teamFlashes = new Set(blinds.filter(e => e.attacker_team_num === e.user_team_num && e.blind_duration >= 1).map(e => e.tick)).size;
    const fx = byType.flash || 0;
    const d1 = v => (v == null || isNaN(v) ? "–" : v.toFixed(2).replace(".", S.dec));
    const pct = v => (v == null || isNaN(v) ? "–" : Math.round(v * 100) + "%");
    const cmp = (mine, avg) => {
      if (mine == null || !avg) return "";
      const r = mine / avg;
      return r >= 1.15 ? ' <span class="up">▲</span>' : r <= 0.85 ? ' <span class="down">▼</span>' : "";
    };
    const row = (label, mine, avg, fmt = d1) => `<tr><td>${esc(label)}</td><td><b>${fmt(mine)}</b>${cmp(mine, avg)}</td><td>${avg == null ? "–" : fmt(avg)}</td></tr>`;
    return `<section class="cm-stats"><h2>${esc(S.vs_h)}</h2>
      <div class="kpis">
        <div class="kpi"><div class="kpi-v">${k.length}/${dd}</div><div class="kpi-l">${esc(S.k_kd)}</div><div class="kpi-s">K/D ${d1(dd ? k.length / dd : k.length)} · HS ${k.length ? Math.round(100 * hs / k.length) : 0}%</div></div>
        <div class="kpi"><div class="kpi-v">${total}</div><div class="kpi-l">${esc(S.k_nades)}</div><div class="kpi-s">${esc(S.k_rounds.replace("{n}", rounds))}</div></div>
        <div class="kpi"><div class="kpi-v">${enemyBl}</div><div class="kpi-l">${esc(S.k_blinded)}</div><div class="kpi-s">${esc(S.k_teamfl.replace("{n}", teamFlashes))}</div></div>
      </div>
      <div class="table-wrap"><table class="uses an-table cm-table"><thead><tr><th></th><th>${esc(S.you)}</th><th>${esc(S.pro_avg)}</th></tr></thead><tbody>
        ${row(S.r_per_round, total / rounds, pro.per_round)}
        ${["smoke", "flash", "molotov", "he"].map(ty => row(`${S.types[ty]} ${S.r_per_round_short}`, byType[ty] / rounds, pro.per_type ? pro.per_type[ty] : null)).join("")}
        ${row(S.r_flash_enemies, fx ? enemyBl / fx : null, pro.flash_enemies)}
        ${row(S.r_team_flash, fx ? teamFlashes / fx : null, pro.team_flash, pct)}
      </tbody></table></div>
      <p class="muted small">${esc(S.vs_help)}</p></section>`;
  }

  // ---------------------------------------------------------------- you vs the pros: heat map on the radar
  function heatBlock(mine) {
    const M = DATA.maps[MAP], R = M.radar; if (!R) return "";
    const k = 1024 / (R.size || 1024);
    const px = p => [((p[0] - R.pos_x) / R.scale) * k, ((R.pos_y - p[1]) / R.scale) * k];
    const T = ["smoke", "flash", "molotov", "he"];
    const pro = M.lineups.map(l => { const [x, y] = px(l.l); return `<circle class="hp t-${l.type}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(22, 7 + 2.2 * Math.sqrt(l.n || 1)).toFixed(1)}"/>`; }).join("");
    const me = mine.map(({ f }) => { const [x, y] = px(f.l); return `<circle class="hm t-${f.type}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9"/>`; }).join("");
    return `<section class="cm-heat"><h2>${esc(S.heat_h)}</h2>
      <div class="cm-heat-ctl small">
        <label class="ov-tg"><input type="checkbox" data-h="me" checked> ● ${esc(S.you)}</label>
        <label class="ov-tg"><input type="checkbox" data-h="pro" checked> ○ ${esc(S.pros)}</label>
        ${T.map(t => `<label class="ov-tg tg-${t}"><input type="checkbox" data-ht="${t}" checked> ${esc(S.types[t])}</label>`).join("")}
      </div>
      <svg class="cm-heat-svg" viewBox="0 0 1024 1024" role="img" aria-label="${esc(S.heat_h)}">
        <image href="/static/radars/${R.slug}.webp" x="0" y="0" width="1024" height="1024"/>
        <g class="g-pro">${pro}</g><g class="g-me">${me}</g>
      </svg>
      <p class="muted small">${esc(S.heat_help)}</p></section>`;
  }
  root.addEventListener("change", e => {
    const c = e.target, box = root.querySelector(".cm-heat"); if (!box) return;
    if (c.dataset.h) box.classList.toggle("hide-" + c.dataset.h, !c.checked);
    if (c.dataset.ht) box.classList.toggle("hide-" + c.dataset.ht, !c.checked);
  });
})();
