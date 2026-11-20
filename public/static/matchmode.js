// "Match mode": a one-screen view for the phone / second monitor. Pick map + side; the radar shows the grenades
// (essentials, all, or one execute), tap one for where to stand, technique, video and the setpos command.
(() => {
  const root = document.getElementById("mm"); if (!root) return;
  const S = JSON.parse(root.dataset.i18n);
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const COL = { smoke: "#c9d0d8", flash: "#f5e66b", molotov: "#ff8a1f", he: "#5fd068" };
  const NS = "http://www.w3.org/2000/svg";
  const params = new URLSearchParams(location.search);

  let DATA = null, M = null, byId = {};
  const st = { map: params.get("map") || ls.get("mmMap") || ls.get("mapPick") || "", side: params.get("side") || ls.get("mmSide") || "T",
               tab: "ess", type: "all", exec: null, sel: null };

  // ------------------------------------------------------------------ exit goes back to the previous page
  $("mmExit").addEventListener("click", (e) => { if (history.length > 1 && document.referrer.includes(location.host)) { e.preventDefault(); history.back(); } });

  // ------------------------------------------------------------------ "back" (page button or phone gesture) stays in the mode
  // opening a grenade or an execute adds a history step; going back closes it (grenade -> radar, execute -> list) instead
  // of leaving the page. Only from the mode's main screen does "back" leave.
  const step = () => { try { history.pushState({ mm: 1 }, ""); } catch (e) {} };
  function undo() {
    if (st.sel) { st.sel = null; closeVideo(); render(); return true; }
    if (st.exec) { st.exec = null; render(); return true; }
    return false;
  }
  window.addEventListener("popstate", () => { undo(); });
  // the mode's own buttons ("list", "whole map") close through history too, so no stale steps are left behind
  const stepBack = () => { if (history.state && history.state.mm) { history.back(); return true; } return false; };
  // (the page's "← Voltar" button already does history.back() — base.html — so it lands on these steps by itself)

  // ------------------------------------------------------------------ keep the screen on (Wake Lock API)
  let lock = null;
  const wake = $("mmWake");
  async function setWake(on) {
    try {
      if (on && "wakeLock" in navigator) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { if (!document.hidden) paintWake(false); }); }
      else if (lock) { await lock.release(); lock = null; }
      paintWake(on && !!lock); ls.set("mmWake", on && lock ? "1" : "0");
    } catch (e) { paintWake(false); }
  }
  const paintWake = (on) => { wake.setAttribute("aria-pressed", on ? "true" : "false"); };
  if (!("wakeLock" in navigator)) wake.hidden = true;
  wake.addEventListener("click", () => setWake(wake.getAttribute("aria-pressed") !== "true"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && ls.get("mmWake") === "1") setWake(true); });

  fetch(root.dataset.src).then((r) => r.json()).then((d) => {
    DATA = d;
    if (!DATA.maps.some((m) => m.slug === st.map)) st.map = DATA.maps[0].slug;
    $("mmMap").value = st.map;
    if (ls.get("mmWake") === "1") setWake(true);
    loadMap();
  }).catch(() => { $("mmBody").innerHTML = `<p class="muted">–</p>`; });

  $("mmMap").addEventListener("change", (e) => { st.map = e.target.value; ls.set("mmMap", st.map); st.exec = null; st.sel = null; loadMap(); });
  root.querySelectorAll("[data-side]").forEach((b) => b.addEventListener("click", () => {
    st.side = b.dataset.side; ls.set("mmSide", st.side); st.exec = null; st.sel = null; render();
  }));
  root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { st.tab = b.dataset.tab; st.exec = null; st.sel = null; render(); }));
  $("mmFull").addEventListener("click", () => { if (!st.sel || !stepBack()) { st.sel = null; render(); } });
  $("mmVclose").addEventListener("click", closeVideo);

  function loadMap() {
    M = DATA.maps.find((m) => m.slug === st.map);
    byId = Object.fromEntries(M.lineups.map((l) => [l.id, l]));
    $("mmImg").setAttribute("href", M.img);
    render();
  }

  // the grenades in view right now (list order = numbers on the radar)
  function current() {
    if (st.tab === "execs") {
      if (!st.exec) return [];
      const e = M.execs.find((x) => x.id === st.exec);
      return e ? e.parts.map(([id, at]) => byId[id] && { ...byId[id], at }).filter(Boolean) : [];
    }
    if (st.tab === "ess") return (M.ess[st.side] || []).map((id) => byId[id]).filter(Boolean);
    return M.lineups.filter((l) => l.s === st.side && (st.type === "all" || l.ty === st.type))
      .sort((a, b) => b.c - a.c);
  }

  function render() {
    closeVideo();
    root.querySelectorAll("[data-side]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.side === st.side ? "true" : "false"));
    root.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === st.tab ? "true" : "false"));
    const items = current();
    drawRadar(items);
    // type chips only on "All"
    const types = $("mmTypes");
    types.hidden = st.tab !== "all" || !!st.sel;
    if (!types.hidden) {
      const have = new Set(M.lineups.filter((l) => l.s === st.side).map((l) => l.ty));
      types.innerHTML = ["all", "smoke", "flash", "molotov", "he"].filter((x) => x === "all" || have.has(x))
        .map((x) => `<button type="button" data-type="${x}" aria-pressed="${st.type === x}">${x !== "all" ? `<i style="background:${COL[x]}"></i>` : ""}${esc(S.types[x])}</button>`).join("");
      types.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => { st.type = b.dataset.type; render(); }));
    }
    const body = $("mmBody");
    if (st.sel && byId[st.sel]) { body.innerHTML = detail(byId[st.sel], items); bindDetail(items); return; }
    if (st.tab === "execs" && !st.exec) { body.innerHTML = execList(); bindExecs(); return; }
    body.innerHTML = (st.tab === "execs" ? execHead() : "") + (items.length ? `<ol class="mm-list">${items.map((l, i) => row(l, i)).join("")}</ol>`
      : `<p class="muted">${esc(S.none)}</p>`) + (items.length ? `<p class="muted small mm-tip">${esc(S.tip)}</p>` : "");
    body.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => select(b.dataset.id)));
    const back = body.querySelector("[data-back]"); if (back) back.addEventListener("click", () => { if (!stepBack()) { st.exec = null; render(); } });
    body.scrollTop = 0;
  }

  const row = (l, i) => `<li><button type="button" data-id="${l.id}">
      <span class="mm-num" style="--c:${COL[l.ty]}">${i + 1}</span>
      <span class="mm-row-main"><b>${esc(l.n)}</b><span class="muted small">${esc(l.fr)}${l.te ? " · " + esc(l.te) : ""}${l.mc && window.PNmouse ? " " + window.PNmouse(l.mc) : ""}</span></span>
      ${l.at != null ? `<span class="mm-at">${l.at > 0 ? "+" : ""}${String(l.at).replace(".", root.dataset.lang === "pt" ? "," : ".")}s</span>` : ""}
    </button></li>`;

  function execList() {
    const xs = M.execs.filter((e) => e.s === st.side);
    if (!xs.length) return `<p class="muted">${esc(S.none)}</p>`;
    return `<ol class="mm-list">${xs.map((e) => `<li><button type="button" data-exec="${e.id}">
      <span class="mm-num mm-n2">${e.parts.length}</span>
      <span class="mm-row-main"><b>${esc(e.a || "?")}</b><span class="muted small">${esc(S.seen.replace("{n}", e.seen))} · ${esc(S.win.replace("{p}", Math.round(e.w * 100)))}</span></span>
      <span class="mm-go">›</span></button></li>`).join("")}</ol>`;
  }
  function bindExecs() { $("mmBody").querySelectorAll("[data-exec]").forEach((b) => b.addEventListener("click", () => { st.exec = b.dataset.exec; step(); render(); })); }
  function execHead() {
    const e = M.execs.find((x) => x.id === st.exec);
    return `<div class="mm-head"><button type="button" class="mm-link" data-back>${esc(S.list)}</button>
      <b>${esc(e.a)}</b> <a class="small" href="${e.u}">${esc(S.open)} →</a></div>`;
  }

  function detail(l, items) {
    const i = items.findIndex((x) => x.id === l.id);
    return `<div class="mm-detail">
      <div class="mm-head"><button type="button" class="mm-link" data-list>${esc(S.list)}</button>
        <span class="mm-nav"><button type="button" data-step="-1" ${i <= 0 ? "disabled" : ""} aria-label="‹">‹</button><span class="muted small">${i + 1}/${items.length}</span><button type="button" data-step="1" ${i >= items.length - 1 ? "disabled" : ""} aria-label="›">›</button></span></div>
      <h2><span class="mm-num" style="--c:${COL[l.ty]}">${i + 1}</span> ${esc(l.n)}</h2>
      <dl class="mm-facts">
        <div><dt>${esc(S.from)}</dt><dd>${esc(l.fr || "?")}</dd></div>
        <div><dt>${esc(S.to)}</dt><dd>${esc(l.to || "?")}</dd></div>
        <div class="wide"><dt>${esc(S.tech)}</dt><dd>${esc(l.te || "?")} ${l.mc && window.PNmouse ? window.PNmouse(l.mc) : ""}</dd></div>
      </dl>
      <p class="muted small">${esc(S.used.replace("{n}", l.c))}</p>
      <div class="mm-actions">
        ${l.v ? `<button type="button" class="btn mm-play" data-video>${esc(S.video)}</button>` : ""}
        ${l.cmd ? `<button type="button" class="btn" data-copycmd>${esc(S.copy)}</button>` : ""}
        <a class="btn" href="${l.u}">${esc(S.open)}</a>
      </div>
    </div>`;
  }
  function bindDetail(items) {
    const body = $("mmBody"), l = byId[st.sel];
    body.querySelector("[data-list]").addEventListener("click", () => { if (!stepBack()) { st.sel = null; render(); } });
    body.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
      const i = items.findIndex((x) => x.id === st.sel) + +b.dataset.step;
      if (items[i]) select(items[i].id);
    }));
    const v = body.querySelector("[data-video]"); if (v) v.addEventListener("click", () => openVideo(l));
    const c = body.querySelector("[data-copycmd]");
    if (c) c.addEventListener("click", () => {
      const done = () => { c.textContent = S.copied; setTimeout(() => { c.textContent = S.copy; }, 1500); };
      (navigator.clipboard ? navigator.clipboard.writeText(l.cmd) : Promise.reject()).then(done, () => { prompt("", l.cmd); });
    });
    body.scrollTop = 0;
  }

  // tapping a grenade plays its video right away over the radar (no video: the radar zooms on where it's thrown)
  function select(id) {
    if (!st.sel) step();   // one history step per opened grenade (switching grenades does not stack steps)
    st.sel = id; render();
    const l = byId[id];
    if (l && l.v) openVideo(l); else closeVideo();
  }

  function openVideo(l) {
    const box = $("mmVideo"), v = box.querySelector("video");
    v.poster = l.po || ""; v.src = l.v; box.hidden = false;
    box.classList.toggle("vert", !!l.vv);
    if (window.PNcaps) window.PNcaps(v, l.vc || []);
    v.play().catch(() => {});
  }
  function closeVideo() { const box = $("mmVideo"), v = box.querySelector("video"); if (!box.hidden) { v.pause(); v.removeAttribute("src"); v.load(); box.hidden = true; } }

  // ------------------------------------------------------------------ radar
  function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
  function drawRadar(items) {
    const dots = $("mmDots"), sel = $("mmSel"), svg = $("mmSvg");
    dots.textContent = ""; sel.textContent = "";
    const s = st.sel && byId[st.sel];
    // the whole map; zoom only on a selected grenade (its whole trajectory), "mapa inteiro" goes back
    const box = s && s.b ? s.b : [0, 0, 1024, 1024];
    svg.setAttribute("viewBox", box.map((v) => Math.round(v)).join(" "));
    const k = box[2] / 1024; // keep markers the same size on screen when zoomed
    $("mmFull").hidden = !s;
    if (s) {
      if (s.p) el("path", { d: s.p, class: "mm-traj", "stroke-width": 4 * k, "stroke-dasharray": `${10 * k} ${7 * k}` }, sel);
      el("circle", { cx: s.t[0], cy: s.t[1], r: 13 * k, class: "mm-throw", "stroke-width": 4 * k }, sel);
      el("text", { x: s.t[0], y: s.t[1] + 34 * k, class: "mm-lbl", "font-size": 22 * k, "stroke-width": 5 * k }, sel).textContent = S.from;
    }
    items.forEach((l, i) => {
      const on = s && s.id === l.id;
      if (s && !on) return; // only the selected one while zoomed in
      const g = el("g", { class: "mm-dot" + (on ? " on" : ""), "data-id": l.id, tabindex: 0, role: "button", "aria-label": `${i + 1}. ${l.n}` }, dots);
      el("circle", { cx: l.l[0], cy: l.l[1], r: 22 * k, fill: COL[l.ty], "stroke-width": 4 * k }, g);
      el("text", { x: l.l[0], y: l.l[1] + 8 * k, "font-size": 23 * k }, g).textContent = i + 1;
      const go = () => select(l.id);
      g.addEventListener("click", go);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }
})();
