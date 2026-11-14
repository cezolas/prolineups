// Search, map filters and copy buttons. No frameworks, no cookies.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const T = window.I18N || {}, LANG = window.LANG || "pt";
  const norm = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // ---------------------------------------------------------------- search
  const q = $("#q"), box = $("#results");
  let index = null, sel = -1;
  async function loadIndex() {
    if (index) return index;
    try { index = await (await fetch(`/dados/busca-${LANG}.json`)).json(); } catch { index = []; }
    index.forEach(it => it._k = norm(it.k + " " + it.n));
    return index;
  }
  const KIND = T.kinds || { lineup: "lineup", jogador: "jogador", time: "time", torneio: "torneio", mapa: "mapa" };
  const ORDER = { mapa: 0, jogador: 1, time: 2, torneio: 3, lineup: 4 };
  async function search() {
    const terms = norm(q.value).split(/\s+/).filter(Boolean);
    if (!terms.length) { box.hidden = true; return; }
    const idx = await loadIndex();
    const hits = idx.filter(it => terms.every(t => it._k.includes(t)))
      .sort((a, b) => ORDER[a.t] - ORDER[b.t]).slice(0, 12);
    sel = -1;
    box.innerHTML = hits.map(h => `<a href="${h.u}"><span class="k">${KIND[h.t]}</span><span>${h.n.replace(/</g, "&lt;")}</span></a>`).join("")
      || `<div class="muted" style="padding:10px 12px">${T.no_results || "Nada encontrado."}</div>`;
    box.hidden = false;
  }
  if (q) {
    q.addEventListener("input", search);
    q.addEventListener("focus", () => { loadIndex(); if (q.value) search(); });
    q.addEventListener("keydown", e => {
      const links = $$("a", box);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
        links.forEach((a, i) => a.classList.toggle("on", i === sel));
      } else if (e.key === "Enter") {
        const a = links[sel] || links[0]; if (a) location.href = a.href;
      } else if (e.key === "Escape") { box.hidden = true; q.blur(); }
    });
    document.addEventListener("click", e => { if (!e.target.closest(".search")) box.hidden = true; });
  }

  // ---------------------------------------------------------------- map filters
  const filters = $("#filters");
  if (filters) {
    const state = { type: "", side: "", area: "", teams: "", players: "", map: "", diff: "", sort: "" };
    const names = { type: "tipo", side: "lado", area: "onde", teams: "time", players: "jogador", map: "mapa", diff: "dificuldade", sort: "ordem" };
    const params = new URLSearchParams(location.search);
    for (const k of Object.keys(state)) state[k] = params.get(names[k]) || "";
    const cards = $$("#cards .card"), box = $("#cards");
    // interactive radar of the map page: same filters + its own type/side checkboxes
    const ov = $("#ov"), ovOff = new Set(), ovItems = new Map();
    if (ov) {
      $$(".ov-item", ov).forEach(g => ovItems.set(g.dataset.id, g));
      const card = id => cards.find(c => c.dataset.id === id);
      const info = $("#ovInfo");
      const select = id => {
        $$(".ov-item.sel", ov).forEach(g => g.classList.remove("sel"));
        const g = ovItems.get(id), c = card(id); if (!g || !c) return;
        g.classList.add("sel"); g.parentNode.appendChild(g);  // on top
        info.innerHTML = `<a class="ov-info-a" href="${c.getAttribute("href")}"><b>${c.querySelector("h3").textContent}</b>
          <span>${c.querySelector(".card-badges").innerHTML}</span><span class="muted small">${c.querySelector("p.muted")?.textContent || ""}</span>
          <span class="ov-open">${(window.I18N || {}).open || "Abrir"} →</span></a>`;
        info.hidden = false;
        $$("#cards .card.hl").forEach(x => x.classList.remove("hl")); c.classList.add("hl");
      };
      ov.addEventListener("click", e => { const g = e.target.closest(".ov-item"); if (g && !g.classList.contains("off")) select(g.dataset.id); });
      ov.addEventListener("keydown", e => { const g = e.target.closest(".ov-item"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(g.dataset.id); } });
      ov.addEventListener("change", e => {
        const i = e.target;
        if (i.dataset.ovLabels !== undefined) { ov.classList.toggle("no-labels", !i.checked); return; }
        const k = i.dataset.ovType || i.dataset.ovSide; if (!k) return;
        i.checked ? ovOff.delete(k) : ovOff.add(k); apply();
      });
      box?.addEventListener("mouseover", e => { const c = e.target.closest(".card"); $$(".ov-item.hov", ov).forEach(g => g.classList.remove("hov")); if (c) ovItems.get(c.dataset.id)?.classList.add("hov"); });
      box?.addEventListener("mouseleave", () => $$(".ov-item.hov", ov).forEach(g => g.classList.remove("hov")));
    }
    const original = cards.slice();
    const SORT = {
      eff: (a, b) => (+b.dataset.eff) - (+a.dataset.eff) || (+b.dataset.count) - (+a.dataset.count),
      easy: (a, b) => (+a.dataset.diff) - (+b.dataset.diff) || (+b.dataset.count) - (+a.dataset.count),
    };
    function apply() {
      let shown = 0;
      for (const c of cards) {
        const ok = (!state.type || c.dataset.type === state.type) && (!state.side || c.dataset.side === state.side) &&
          (!state.area || c.dataset.area === state.area) && (!state.map || c.dataset.map === state.map) &&
          (!state.teams || c.dataset.teams.split(" ").includes(state.teams)) &&
          (!state.players || c.dataset.players.split(" ").includes(state.players)) &&
          (!state.diff || c.dataset.diff === state.diff) &&
          (!ovOff.has(c.dataset.type) && !ovOff.has(c.dataset.side));
        c.hidden = !ok; if (ok) shown++;
        const g = ovItems.get(c.dataset.id); if (g) g.classList.toggle("off", !ok);
      }
      if (box) (state.sort && SORT[state.sort] ? original.slice().sort(SORT[state.sort]) : original).forEach(c => box.appendChild(c));
      $("#shown").textContent = `${shown} ${shown === 1 ? (T.lineup_1 || "lineup") : (T.lineup_n || "lineups")}`;
      $("#empty").hidden = shown > 0;
      $$("button[data-f]", filters).forEach(b => b.classList.toggle("on", state[b.dataset.f] === b.dataset.v));
      $$("select[data-f]", filters).forEach(s => s.value = state[s.dataset.f]);
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(state)) if (v) p.set(names[k], v);
      history.replaceState(null, "", p.toString() ? "?" + p : location.pathname);
    }
    filters.addEventListener("click", e => { const b = e.target.closest("button[data-f]"); if (b) { state[b.dataset.f] = b.dataset.v; apply(); } });
    // quick search on the map page: "I want a smoke on X" -> type + landing place, easiest first
    const quick = $("#rapida");
    if (quick) quick.addEventListener("click", e => {
      const t = e.target.closest("[data-qt]");
      if (t) {
        $$("[data-qt]", quick).forEach(x => x.classList.toggle("on", x === t));
        $$("[data-qt-panel]", quick).forEach(p => { p.hidden = p.dataset.qtPanel !== t.dataset.qt; });
        return;
      }
      const c = e.target.closest("[data-quick]"); if (!c) return;
      const [ty, area] = c.dataset.quick.split("|");
      Object.assign(state, { type: ty, area, side: "", teams: "", players: "", diff: "", sort: "easy" });
      $$("[data-quick]", quick).forEach(x => x.classList.toggle("on", x === c));
      apply();
      filters.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    filters.addEventListener("change", e => { const s = e.target.closest("select[data-f]"); if (s) { state[s.dataset.f] = s.value; apply(); } });
    apply();
  }

  // ---------------------------------------------------------------- mobile menu (drawer)
  const side = $("#side"), scrim = $("#scrim"), menuBtn = $("#menuBtn");
  function menu(open) {
    side.classList.toggle("open", open); scrim.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open)); document.body.style.overflow = open ? "hidden" : "";
  }
  if (menuBtn) {
    const desktop = () => matchMedia("(min-width: 961px)").matches;
    menuBtn.addEventListener("click", () => {
      if (desktop()) {  // desktop: collapse / expand the whole sidebar, remembered in this browser
        const off = document.documentElement.classList.toggle("side-off");
        menuBtn.setAttribute("aria-expanded", String(!off));
        try { localStorage.setItem("sideOff", off ? "1" : ""); } catch (e) {}
        return;
      }
      menu(!side.classList.contains("open"));
    });
    if (desktop()) menuBtn.setAttribute("aria-expanded", String(!document.documentElement.classList.contains("side-off")));
    scrim.addEventListener("click", () => menu(false));
    document.addEventListener("keydown", e => { if (e.key === "Escape") menu(false); });
    side.querySelector("[aria-current]")?.scrollIntoView({ block: "center" });
  }

  // ---------------------------------------------------------------- copy buttons
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    const text = $(b.dataset.copy)?.textContent.trim(); if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch {
      const r = document.createRange(); r.selectNodeContents($(b.dataset.copy)); getSelection().removeAllRanges(); getSelection().addRange(r);
    }
    const old = b.textContent; b.textContent = T.copied || "Copiado!"; setTimeout(() => b.textContent = old, 1500);
  });
})();

// light / dark toggle (choice kept in this browser; default dark)
(function () {
  const b = document.getElementById("themeBtn"); if (!b) return;
  const meta = document.querySelector('meta[name="theme-color"]');
  const sync = () => { const light = document.documentElement.dataset.theme === "light";
    b.setAttribute("aria-pressed", String(light)); if (meta) meta.content = light ? "#ffffff" : "#0b0f15"; };
  b.addEventListener("click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    if (light) document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("theme", light ? "light" : "dark"); } catch (e) {}
    sync();
  });
  sync();
})();

// favourites ("my list"): kept in this browser only, no account
(function () {
  const KEY = "favs";
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } };
  const write = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // links are per language: /pt/mirage/x/ and /en/mirage/x/ are the same lineup
  const key = url => url.replace(/^\/[a-z]{2}\//, "/");
  function paint() {
    const favs = read(), set = new Set(favs.map(f => key(f.url)));
    const n = document.getElementById("favCount"); if (n) n.textContent = favs.length || "";
    document.querySelectorAll("a.card").forEach(c => c.classList.toggle("is-fav", set.has(key(c.getAttribute("href")))));
    const b = document.getElementById("favBtn");
    if (b) {
      const on = set.has(key(JSON.parse(b.dataset.fav).url));
      b.setAttribute("aria-pressed", String(on)); b.classList.toggle("on", on);
      b.textContent = (on ? "★ " : "☆ ") + (on ? b.dataset.on : b.dataset.off);
    }
    const list = document.getElementById("favList");
    if (list) {
      const L = "/" + (window.LANG || "pt");
      list.innerHTML = favs.map(f => {
        const url = L + key(f.url);
        return `<div class="row-link fav-row"><a class="row-name" href="${esc(url)}">${esc(f.name)}</a>
          <span class="row-sub muted">${esc(f.map)} · ${esc(f.side)} · ${esc(f.type)}</span>
          <button class="btn small row-n" data-unfav="${esc(f.url)}" aria-label="remove">✕</button></div>`;
      }).join("");
      document.getElementById("favEmpty").hidden = favs.length > 0;
    }
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("#favBtn");
    if (b) {
      const f = JSON.parse(b.dataset.fav), favs = read(), i = favs.findIndex(x => key(x.url) === key(f.url));
      if (i >= 0) favs.splice(i, 1); else favs.unshift(f);
      write(favs); paint(); return;
    }
    const u = e.target.closest("[data-unfav]");
    if (u) { write(read().filter(x => key(x.url) !== key(u.dataset.unfav))); paint(); }
  });
  paint();
})();
