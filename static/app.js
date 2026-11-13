// Search, map filters and copy buttons. No frameworks, no cookies.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const norm = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // ---------------------------------------------------------------- search
  const q = $("#q"), box = $("#results");
  let index = null, sel = -1;
  async function loadIndex() {
    if (index) return index;
    try { index = await (await fetch("/dados/busca.json")).json(); } catch { index = []; }
    index.forEach(it => it._k = norm(it.k + " " + it.n));
    return index;
  }
  const KIND = { lineup: "lineup", jogador: "jogador", time: "time", torneio: "torneio", mapa: "mapa" };
  const ORDER = { mapa: 0, jogador: 1, time: 2, torneio: 3, lineup: 4 };
  async function search() {
    const terms = norm(q.value).split(/\s+/).filter(Boolean);
    if (!terms.length) { box.hidden = true; return; }
    const idx = await loadIndex();
    const hits = idx.filter(it => terms.every(t => it._k.includes(t)))
      .sort((a, b) => ORDER[a.t] - ORDER[b.t]).slice(0, 12);
    sel = -1;
    box.innerHTML = hits.map(h => `<a href="${h.u}"><span class="k">${KIND[h.t]}</span><span>${h.n.replace(/</g, "&lt;")}</span></a>`).join("")
      || `<div class="muted" style="padding:10px 12px">Nada encontrado.</div>`;
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
    const state = { type: "", side: "", area: "", teams: "", players: "" };
    const params = new URLSearchParams(location.search);
    for (const k of Object.keys(state)) state[k] = params.get(k === "teams" ? "time" : k === "players" ? "jogador" : k === "type" ? "tipo" : k === "side" ? "lado" : "onde") || "";
    const cards = $$("#cards .card");
    function apply() {
      let shown = 0;
      for (const c of cards) {
        const ok = (!state.type || c.dataset.type === state.type) && (!state.side || c.dataset.side === state.side) &&
          (!state.area || c.dataset.area === state.area) &&
          (!state.teams || c.dataset.teams.split(" ").includes(state.teams)) &&
          (!state.players || c.dataset.players.split(" ").includes(state.players));
        c.hidden = !ok; if (ok) shown++;
      }
      $("#shown").textContent = `${shown} lineup${shown === 1 ? "" : "s"}`;
      $("#empty").hidden = shown > 0;
      $$("button[data-f]", filters).forEach(b => b.classList.toggle("on", state[b.dataset.f] === b.dataset.v));
      $$("select[data-f]", filters).forEach(s => s.value = state[s.dataset.f]);
      const p = new URLSearchParams();
      const names = { type: "tipo", side: "lado", area: "onde", teams: "time", players: "jogador" };
      for (const [k, v] of Object.entries(state)) if (v) p.set(names[k], v);
      history.replaceState(null, "", p.toString() ? "?" + p : location.pathname);
    }
    filters.addEventListener("click", e => { const b = e.target.closest("button[data-f]"); if (b) { state[b.dataset.f] = b.dataset.v; apply(); } });
    filters.addEventListener("change", e => { const s = e.target.closest("select[data-f]"); if (s) { state[s.dataset.f] = s.value; apply(); } });
    apply();
  }

  // ---------------------------------------------------------------- copy buttons
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    const text = $(b.dataset.copy)?.textContent.trim(); if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch {
      const r = document.createRange(); r.selectNodeContents($(b.dataset.copy)); getSelection().removeAllRanges(); getSelection().addRange(r);
    }
    const old = b.textContent; b.textContent = "Copiado!"; setTimeout(() => b.textContent = old, 1500);
  });
})();
