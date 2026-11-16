// "My tactics": the grenades saved per map ("favs", same list as the ☆ button on a grenade page) and the executes
// built from them ("tactics": who throws what and when, saved by name, shareable by link, downloadable as a practice .cfg).
// Without an account everything stays in this browser; signed in, accounts.js syncs both keys.
(() => {
  const root = document.getElementById("mt"); if (!root) return;
  const S = JSON.parse(root.dataset.i18n);
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const COL = { smoke: "#c9d0d8", flash: "#f5e66b", molotov: "#ff8a1f", he: "#5fd068" };
  const NS = "http://www.w3.org/2000/svg";
  const push = (k) => window.PN && window.PN.push && window.PN.push(k);
  const key = (u) => String(u || "").replace(/^\/[a-z]{2}\//, "/");   // same grenade in every language
  const mapOf = (u) => key(u).split("/")[1] || "";

  const favs = () => { try { return JSON.parse(ls.get("favs") || "[]"); } catch (e) { return []; } };
  const setFavs = (v) => { ls.set("favs", JSON.stringify(v)); push("favs"); };
  const tacs = () => { let v = null; try { v = JSON.parse(ls.get("tactics") || "null"); } catch (e) {} return v && Array.isArray(v.items) ? v : { items: [], del: [] }; };
  const setTacs = (v) => { ls.set("tactics", JSON.stringify(v)); push("tactics"); };

  let DATA = null, M = null, byKey = {}, byId = {};
  const st = { map: "", side: ls.get("mtSide") || "T", exe: null };
  const drafts = {};  // unsaved execute per map + side
  const draft = () => (drafts[`${st.map}:${st.side}`] ||= { id: null, n: "", parts: [] });

  // a shared execute arrives as ?exe=<base64url JSON>
  let shared = null;
  try {
    const q = new URLSearchParams(location.search).get("exe");
    if (q) shared = JSON.parse(decodeURIComponent(escape(atob(q.replace(/-/g, "+").replace(/_/g, "/")))));
  } catch (e) { shared = null; }

  fetch(root.dataset.src).then((r) => r.json()).then((d) => {
    DATA = d;
    for (const m of d.maps) for (const l of m.lineups) byKey[key(l.u)] = { m: m.slug, l };
    const saved = favs().map((f) => mapOf(f.url));
    if (shared && d.maps.some((m) => m.slug === shared.m)) {
      st.map = shared.m; st.side = shared.s === "CT" ? "CT" : "T";
      drafts[`${st.map}:${st.side}`] = { id: null, n: String(shared.n || "").slice(0, 60),
        parts: (shared.p || []).map(([id, p, at]) => ({ id: String(id), p: +p || 1, at: +at || 0 })) };
      $("mtShared").hidden = false;
    } else {
      const pref = ls.get("mtMap");
      st.map = [pref, ...saved, d.maps[0].slug].find((s) => s && d.maps.some((m) => m.slug === s));
    }
    render();
  }).catch(() => { $("mtSaved").innerHTML = `<p class="muted">–</p>`; });

  // ------------------------------------------------------------------ render
  function render() {
    if (!DATA) return;
    M = DATA.maps.find((m) => m.slug === st.map);
    byId = Object.fromEntries(M.lineups.map((l) => [l.id, l]));
    $("mtImg").setAttribute("href", M.img);
    closeVideo();
    // map chips: count of saved grenades per map
    const n = {}; favs().forEach((f) => { const k = mapOf(f.url); n[k] = (n[k] || 0) + 1; });
    $("mtMaps").innerHTML = DATA.maps.map((m) => `<button type="button" role="tab" class="chip${n[m.slug] ? " has" : ""}" data-map="${esc(m.slug)}"
      aria-selected="${m.slug === st.map}">${esc(m.name)}${n[m.slug] ? ` <b>${n[m.slug]}</b>` : ""}</button>`).join("");
    root.querySelectorAll("[data-side]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.side === st.side ? "true" : "false"));

    const d = draft(), inExe = new Set(d.parts.map((p) => p.id));
    // saved grenades of this map + side
    const mine = savedHere();
    $("mtSaved").innerHTML = mine.map((l) => `<div class="row-link mt-row">
        <span class="mt-ty" style="background:${COL[l.ty] || "#999"}" title="${esc(S.types[l.ty] || l.ty)}"></span>
        <span class="mt-txt"><a class="row-name" href="${esc(l.u)}">${esc(l.n)}</a>
          <span class="row-sub muted">${esc(l.fr || "?")}${l.te ? ` · ${esc(l.te)}` : ""}</span></span>
        ${l.v ? `<button class="btn small" type="button" data-play="${esc(l.id)}" aria-label="${esc(S.video)}">▶</button>` : ""}
        <button class="btn small mt-tog${inExe.has(l.id) ? " on" : ""}" type="button" data-tog="${esc(l.id)}" aria-pressed="${inExe.has(l.id)}">${inExe.has(l.id) ? S.in_exe : S.to_exe}</button>
        <button class="btn small" type="button" data-unfav="${esc(l.u)}" aria-label="${esc(S.remove)}" title="${esc(S.remove)}">✕</button>
      </div>`).join("");
    $("mtEmpty").hidden = mine.length > 0;
    // "add a grenade of this map": the rest of this side, most used first
    const have = new Set(mine.map((l) => l.id));
    $("mtAdd").innerHTML = `<option value="">${esc(S.add)}</option>` + M.lineups.filter((l) => l.s === st.side && !have.has(l.id))
      .sort((a, b) => b.c - a.c).map((l) => `<option value="${esc(l.id)}">${esc(S.types[l.ty] || l.ty)} · ${esc(l.n)}</option>`).join("");

    // the execute being built
    $("mtName").value = d.n;
    $("mtExe").innerHTML = d.parts.length ? d.parts.map((p, i) => {
      const l = byId[p.id]; if (!l) return "";
      return `<li class="mt-part" style="--c:${COL[l.ty] || "#999"}">
        <span class="mt-num">${i + 1}</span>
        <span class="mt-txt"><b>${esc(l.n)}</b><span class="row-sub muted">${esc(l.fr || "?")}${l.te ? ` · ${esc(l.te)}` : ""}</span></span>
        <label>${esc(S.player)} <select data-pl="${i}">${[1, 2, 3, 4, 5].map((x) => `<option${x === p.p ? " selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>${esc(S.at)} <input type="number" min="0" max="115" step="0.5" value="${p.at}" data-at="${i}"></label>
        <span class="mt-move"><button class="btn small" type="button" data-up="${i}" aria-label="↑"${i ? "" : " disabled"}>↑</button><button class="btn small" type="button" data-down="${i}" aria-label="↓"${i < d.parts.length - 1 ? "" : " disabled"}>↓</button><button class="btn small" type="button" data-out="${i}" aria-label="${esc(S.remove)}">✕</button></span>
      </li>`;
    }).join("") : `<li class="muted mt-none">${esc(S.exe_none)}</li>`;
    ["mtSave", "mtCfg", "mtLink"].forEach((id) => { $(id).disabled = !d.parts.length; });

    // saved executes of this map
    const T = tacs().items.filter((x) => x.m === st.map).sort((a, b) => b.at - a.at);
    $("mtExes").innerHTML = T.length ? T.map((x) => `<div class="row-link mt-row${d.id === x.id ? " cur" : ""}">
        <span class="badge side-${x.s}">${esc(S.side[x.s])}</span>
        <span class="mt-txt"><b>${esc(x.n)}</b><span class="row-sub muted">${esc(S.n_gren.replace("{n}", x.p.length))}</span></span>
        <button class="btn small" type="button" data-open="${esc(x.id)}">${esc(S.open)}</button>
        <button class="btn small" type="button" data-del="${esc(x.id)}" aria-label="${esc(S.del)}" title="${esc(S.del)}">✕</button>
      </div>`).join("") : `<p class="muted">${esc(S.exes_none)}</p>`;

    drawRadar(mine, d);
  }

  function savedHere() {
    const out = [];
    for (const f of favs()) {
      const x = byKey[key(f.url)];
      if (x && x.m === st.map && x.l.s === st.side) out.push(x.l);
    }
    return out;
  }

  // ------------------------------------------------------------------ radar: saved grenades (small), the execute (numbered, with trajectory)
  function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
  function drawRadar(mine, d) {
    const lines = $("mtLines"), dots = $("mtDots");
    lines.textContent = ""; dots.textContent = "";
    const inExe = new Map(d.parts.map((p, i) => [p.id, i]));
    for (const l of mine) {
      if (inExe.has(l.id)) continue;
      const g = el("g", { class: "mm-dot mt-ghost", tabindex: 0, role: "button", "aria-label": `${S.to_exe}: ${l.n}` }, dots);
      el("circle", { cx: l.l[0], cy: l.l[1], r: 15, fill: COL[l.ty], "stroke-width": 3 }, g);
      const go = () => toggle(l.id);
      g.addEventListener("click", go);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    }
    d.parts.forEach((p, i) => {
      const l = byId[p.id]; if (!l) return;
      if (l.p) el("path", { d: l.p, class: "mm-traj", "stroke-width": 3, "stroke-dasharray": "9 6" }, lines);
      el("circle", { cx: l.t[0], cy: l.t[1], r: 9, class: "mm-throw", "stroke-width": 3 }, lines);
      const g = el("g", { class: "mm-dot on", tabindex: 0, role: "button", "aria-label": `${i + 1}. ${l.n}` }, dots);
      el("circle", { cx: l.l[0], cy: l.l[1], r: 22, fill: COL[l.ty], "stroke-width": 4 }, g);
      el("text", { x: l.l[0], y: l.l[1] + 8, "font-size": 23 }, g).textContent = i + 1;
      const go = () => l.v && play(l);
      g.addEventListener("click", go);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  function play(l) {
    const box = $("mtVideo"), v = box.querySelector("video");
    v.poster = l.po || ""; v.src = l.v; box.hidden = false;
    box.classList.toggle("vert", !!l.vv);
    if (window.PNcaps) window.PNcaps(v, l.vc || []);
    v.play().catch(() => {});
  }
  function closeVideo() { const box = $("mtVideo"), v = box.querySelector("video"); if (!box.hidden) { v.pause(); v.removeAttribute("src"); v.load(); box.hidden = true; } }
  $("mtVclose").addEventListener("click", closeVideo);

  // ------------------------------------------------------------------ actions
  function toggle(id) {
    const d = draft(), i = d.parts.findIndex((p) => p.id === id);
    if (i >= 0) d.parts.splice(i, 1);
    else if (d.parts.length < 10) {
      const last = d.parts[d.parts.length - 1];
      d.parts.push({ id, p: (d.parts.length % 5) + 1, at: last ? last.at : 0 });
    }
    render();
  }
  const msg = (s) => { const m = $("mtMsg"); m.textContent = s; clearTimeout(msg.t); msg.t = setTimeout(() => { m.textContent = ""; }, 2500); };
  const defName = () => `${S.exe_default} ${S.side[st.side]} · ${M.name}`;

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    const d = draft(), ds = b.dataset;
    if (ds.map) { st.map = ds.map; ls.set("mtMap", st.map); render(); return; }
    if (ds.side) { st.side = ds.side; ls.set("mtSide", st.side); render(); return; }
    if (ds.tog) { toggle(ds.tog); return; }
    if (ds.play) { const l = byId[ds.play]; if (l) { play(l); $("mtSvg").scrollIntoView({ block: "nearest", behavior: "smooth" }); } return; }
    if (ds.unfav) {
      const k = key(ds.unfav); setFavs(favs().filter((f) => key(f.url) !== k));
      const x = byKey[k]; if (x) d.parts = d.parts.filter((p) => p.id !== x.l.id);
      render(); return;
    }
    if (ds.up || ds.down) {
      const i = +(ds.up || ds.down), j = ds.up ? i - 1 : i + 1;
      [d.parts[i], d.parts[j]] = [d.parts[j], d.parts[i]]; render(); return;
    }
    if (ds.out) { d.parts.splice(+ds.out, 1); render(); return; }
    if (ds.open) {
      const x = tacs().items.find((y) => y.id === ds.open); if (!x) return;
      st.side = x.s;
      drafts[`${st.map}:${st.side}`] = { id: x.id, n: x.n, parts: x.p.map(([id, p, at]) => ({ id, p, at })) };
      render(); $("mtExe").scrollIntoView({ block: "nearest", behavior: "smooth" }); return;
    }
    if (ds.del) {
      const x = tacs().items.find((y) => y.id === ds.del);
      if (x && !confirm(S.del_confirm.replace("{n}", x.n))) return;
      const v = tacs(); v.items = v.items.filter((y) => y.id !== ds.del); v.del = [...new Set([...(v.del || []), ds.del])].slice(-200);
      setTacs(v);
      Object.values(drafts).forEach((y) => { if (y.id === ds.del) y.id = null; });
      render(); return;
    }
    if (b.id === "mtSave") {
      d.n = ($("mtName").value || "").trim().slice(0, 60) || defName();
      d.id ||= Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const v = tacs(), item = { id: d.id, m: st.map, s: st.side, n: d.n, p: d.parts.map((p) => [p.id, p.p, p.at]), at: Date.now() };
      v.items = [item, ...v.items.filter((y) => y.id !== d.id)].slice(0, 100);
      setTacs(v);
      // its grenades join the saved list too (e.g. an execute received by link)
      const f = favs(), have = new Set(f.map((x) => key(x.url)));
      const add = d.parts.map((p) => byId[p.id]).filter((l) => l && !have.has(key(l.u)))
        .map((l) => ({ url: l.u, name: l.n, map: M.name, type: l.ty, side: S.side[l.s] }));
      if (add.length) setFavs([...add, ...f]);
      if (!$("mtShared").hidden) { $("mtShared").hidden = true; history.replaceState(null, "", location.pathname); }
      render(); msg(S.saved_ok); return;
    }
    if (b.id === "mtCfg") { downloadCfg(d); return; }
    if (b.id === "mtLink") {
      const n = ($("mtName").value || "").trim() || defName();
      const raw = btoa(unescape(encodeURIComponent(JSON.stringify({ m: st.map, s: st.side, n, p: d.parts.map((p) => [p.id, p.p, p.at]) }))));
      const url = `${location.origin}${location.pathname}?exe=${raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => msg(S.copied), () => prompt(S.link, url));
      return;
    }
    if (b.id === "mtClear") { drafts[`${st.map}:${st.side}`] = { id: null, n: "", parts: [] }; render(); }
  });
  root.addEventListener("change", (e) => {
    const d = draft(), x = e.target;
    if (x.id === "mtAdd" && x.value) {
      const l = byId[x.value]; if (!l) return;
      setFavs([{ url: l.u, name: l.n, map: M.name, type: l.ty, side: S.side[l.s] }, ...favs().filter((f) => key(f.url) !== key(l.u))]);
      render(); return;
    }
    if (x.dataset.pl) { d.parts[+x.dataset.pl].p = +x.value; drawRadar(savedHere(), d); }
    if (x.dataset.at) { d.parts[+x.dataset.at].at = Math.max(0, Math.min(115, +x.value || 0)); }
  });
  $("mtName").addEventListener("input", (e) => { draft().n = e.target.value; });

  // ------------------------------------------------------------------ practice .cfg (offline server only)
  const ascii = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "").replace(/[";']/g, "").trim();
  function downloadCfg(d) {
    const name = ($("mtName").value || "").trim() || defName();
    const slug = ascii(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "exe";
    const file = `pronades_exe_${st.map}_${slug}`;
    const parts = d.parts.map((p) => ({ ...p, l: byId[p.id] })).filter((p) => p.l);
    const n = parts.length;
    const out = [`// Pronades - ${ascii(name)} (${ascii(M.name)}, ${st.side}) - ${n} - ${new Date().toISOString().slice(0, 10)}`,
      ...S.cfg_help.map((x) => `// ${ascii(x.replace("{f}", file))}`), "",
      "sv_cheats 1; sv_infinite_ammo 1; ammo_grenade_limit_total 5; sv_grenade_trajectory_prac_pipreview 1",
      "mp_warmup_end; mp_freezetime 0; mp_roundtime_defuse 60; mp_buy_anywhere 1; mp_buytime 9999; bot_kick",
      "give weapon_smokegrenade; give weapon_flashbang; give weapon_hegrenade; give weapon_molotov; give weapon_incgrenade", ""];
    parts.forEach((p, i) => {
      const k = i + 1, nx = (i + 1) % n + 1, pv = (i - 1 + n) % n + 1;
      const label = ascii(`[${k}/${n}] ${S.player} ${p.p} +${p.at}s - ${S.types[p.l.ty] || p.l.ty} - ${p.l.n}${p.l.te ? " - " + p.l.te : ""}`);
      out.push(`alias exe_${k} "${p.l.cmd ? p.l.cmd + "; " : ""}echo ${label}; alias exe_next exe_${nx}; alias exe_prev exe_${pv}"`);
    });
    out.push("", "alias exe_next exe_1", `alias exe_prev exe_${n}`, `echo ${ascii(S.cfg_ready.replace("{n}", n))}`, "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([out.join("\n")], { type: "text/plain" }));
    a.download = `${file}.cfg`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    window.PN && window.PN.log && window.PN.log("download", `${file}.cfg`);
  }

  document.addEventListener("pn:synced", render);
  const note = () => { if (window.PN && window.PN.me) $("mtNote").hidden = true; };
  document.addEventListener("pn:me", note); note();
})();
