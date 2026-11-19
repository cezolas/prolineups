// "Minha Steam": the signed-in user's CS2 stats from Steam (/api/steam), on the same scale as the pros in our demos
// (pipeline/perf.py -> /dados/perf-pop.json). Steam only keeps account totals (every mode together) and the last match.
(() => {
  const root = document.getElementById("st"); if (!root) return;
  const S = JSON.parse(root.dataset.i18n), lang = root.dataset.lang;
  const $ = (s) => root.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v, n = 2) => (v == null || isNaN(v) ? "–" : (+v).toFixed(n).replace(".", S.dec));
  const int = (v) => (v == null ? "–" : Math.round(v).toLocaleString(lang === "pt" ? "pt-BR" : "en-GB"));
  const mapLink = (key) => {
    const k = String(key || "").replace(/^de_/, ""), m = S.maps[k];
    const name = k.charAt(0).toUpperCase() + k.slice(1);
    return m ? `<a href="${m}">${esc(name)}</a>` : esc(name);
  };
  // categories (Steam has no opening duels, clutches or utility: only what it measures the same way as our demos)
  const CATS = { fragging: [["kpr", 1]], survival: [["surv", 1]], aim: [["hs", 1]], sniping: [["snipe_r", 1]] };
  const metrics = (x) => { const r = Math.max(x.rounds, 1); return { kpr: x.kills / r, surv: 1 - x.deaths / r, hs: x.kills ? (x.hs || 0) / x.kills : 0, snipe_r: (x.awp || 0) / r }; };
  function pct(pop, k, v) {
    const xs = (pop.dist || {})[k] || []; if (!xs.length) return 50;
    if (v <= 0) return 0;
    let lo = 0, hi = 0; for (const x of xs) { if (x < v) lo++; if (x <= v) hi++; }
    return 100 * (lo + hi) / 2 / xs.length;
  }
  function profile(pop, m) {
    const ratio = (k) => (pop.mean[k] ? m[k] / pop.mean[k] : 1);
    const rating = (.35 * ratio("kpr") + .25 * ratio("surv")) / .6;   // only kills and survival exist on Steam
    const cats = {};
    for (const [c, ws] of Object.entries(CATS)) cats[c] = Math.round(ws.reduce((a, [k, w]) => a + (m[k] == null ? 50 : pct(pop, k, m[k])) * w, 0));
    return { rating, cats };
  }
  const cls = (x) => (x >= 1.1 ? "good" : x < .9 ? "bad" : "");
  function card(pf, based, pro, keys) {
    return `<div class="perf-card${pro ? " vs" : ""}">
      ${pro ? `<div class="perf-vs muted small"><span>${esc(S.you)}</span><span class="pro">${esc(pro.name)}</span></div>` : ""}
      <div class="perf-rating" title="${esc(S.perf_help)}"><span>${esc(S.rating)}</span><span><b class="${cls(pf.rating)}">${num(pf.rating)}</b>${pro ? ` <b class="pro">${num(pro.pf.rating)}</b>` : ""}</span></div>
      ${keys.map((c) => { const v = pf.cats[c], pv = pro ? pro.pf.cats[c] : null;
        return `<div class="perf-row" title="${esc(S.tips[c])}"><span>${esc(S.cats[c])}</span><b>${v}<small>/100</small>${pro ? ` <span class="pro">${pv}</span>` : ""}</b>
          <i class="perf-bar"><i style="width:${v}%" class="${v >= 70 ? "hi" : v < 30 ? "lo" : ""}"></i>${pro ? `<em class="pro-mark" style="left:${pv}%"></em>` : ""}</i></div>`; }).join("")}
      <div class="muted small perf-based">${esc(based)}</div></div>`;
  }
  let SEL = "all", PRO = null;
  const popFor = (pop) => (SEL !== "all" && pop.by_role && pop.by_role[SEL] ? pop.by_role[SEL] : pop);

  const popP = fetch("/dados/perf-pop.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  fetch("/api/steam").then(async (r) => {
    $("#stLoading").hidden = true;
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { $("#stOut").hidden = false; return; }
    if (r.status === 404) { $("#stLink").hidden = false; return; }
    if (r.status === 403) { $("#stPrivate").hidden = false; return; }
    if (!r.ok || !j.steam) { $("#stBox").innerHTML = `<p class="muted">${esc(S.error)}</p>`; return; }
    render(j.steam, await popP);
  }).catch(() => { $("#stLoading").hidden = true; $("#stBox").innerHTML = `<p class="muted">${esc(S.error)}</p>`; });

  function render(s, pop) {
    const L = s.life, R = Math.max(L.rounds, 1);
    const head = `<div class="fc-head">
      ${s.picture ? `<img src="${esc(s.picture)}" alt="" width="64" height="64" referrerpolicy="no-referrer">` : ""}
      <div><b class="fc-nick">${esc(s.name || "Steam")}</b>
        <div class="muted small">${int(L.hours)} ${esc(S.hours)} · ${int(L.matches)} ${esc(S.k_matches).toLowerCase()}</div></div></div>`;
    const kpis = `<div class="kpis">
      <div class="kpi"><div class="kpi-v">${L.matches ? Math.round(100 * L.wins / L.matches) : "–"}%</div><div class="kpi-l">${esc(S.k_winrate)}</div></div>
      <div class="kpi"><div class="kpi-v">${num(L.deaths ? L.kills / L.deaths : null)}</div><div class="kpi-l">K/D</div></div>
      <div class="kpi"><div class="kpi-v">${L.kills ? Math.round(100 * L.hs / L.kills) : "–"}%</div><div class="kpi-l">HS%</div></div>
      <div class="kpi"><div class="kpi-v">${L.damage ? Math.round(L.damage / R) : "–"}</div><div class="kpi-l">ADR</div></div>
      <div class="kpi"><div class="kpi-v">${int(L.mvps)}</div><div class="kpi-l">MVPs</div></div></div>`;
    let perf = "", last = "";
    if (pop) {
      const P = popFor(pop), me = profile(P, metrics(L));
      const roles = Object.keys(pop.by_role || {});
      const opts = [["all", S.cmp_all], ...roles.map((r) => [r, S.cmp_role.replace("{r}", S.roles[r] || r)])]
        .map(([v, l]) => `<option value="${v}"${v === SEL ? " selected" : ""}>${esc(l)}</option>`).join("");
      const grp = SEL !== "all" ? (pop.roles && pop.roles.profiles[SEL]) : null;
      const pros = grp ? (grp.players || []).filter((x) => x.slug && (pop.pros || {})[x.slug])
        .map((x) => `<button type="button" class="pro-pick${x.slug === PRO ? " on" : ""}" data-pro="${esc(x.slug)}">${esc(x.name)}</button>`).join(" ") : "";
      const pr = PRO && (pop.pros || {})[PRO];
      const proCard = pr ? { name: pr.name, pf: profile(P, { ...pr.m }) } : null;
      perf = `<section class="perf-sec"><h2>${esc(S.perf_h)}</h2>
        <label class="fc-cmp">${esc(S.cmp_with)} <select id="stCmp">${opts}</select></label>
        ${pros ? `<p class="small pro-picks">${esc(S.group_pros)} ${pros} <span class="muted">${esc(S.pro_pick_help)}</span>${pr ? ` <a class="small" href="/${lang}/${S.player_path}/${PRO}/">${esc(S.pro_page)} ↗</a>` : ""}</p>`
               : `<p class="muted small">${esc(S.pick_group)}</p>`}
        ${L.deaths > L.rounds * 0.9 ? `<p class="small st-warn">⚠ ${esc(S.dm_warn)}</p>` : ""}
        ${card(me, S.perf_based.replace("{r}", int(L.rounds)), proCard, Object.keys(CATS))}
        <p class="muted small">${esc(S.perf_help)}</p></section>`;
      if (s.last && s.last.rounds) {
        const lm = profile(P, metrics({ ...s.last, hs: 0, awp: 0 }));
        last = `<section><h2>${esc(S.last_h)}</h2><div class="kpis">
          <div class="kpi"><div class="kpi-v">${s.last.kills}–${s.last.deaths}</div><div class="kpi-l">K–D</div></div>
          <div class="kpi"><div class="kpi-v">${Math.round(s.last.damage / s.last.rounds)}</div><div class="kpi-l">ADR</div></div>
          <div class="kpi"><div class="kpi-v">${s.last.mvps}</div><div class="kpi-l">MVPs</div></div>
          <div class="kpi"><div class="kpi-v"><b class="${cls(lm.rating)}">${num(lm.rating)}</b></div><div class="kpi-l">${esc(S.rating)}</div></div>
          <div class="kpi"><div class="kpi-v">${s.last.rounds}</div><div class="kpi-l">${esc(S.rounds)}</div></div></div>
          <p class="muted small">${esc(S.last_help)}</p></section>`;
      }
    }
    const maps = (s.maps || []).length ? `<section><h2>${esc(S.maps_h)}</h2><div class="table-wrap"><table class="uses an-table">
      <thead><tr><th>${esc(S.th_map)}</th><th>${esc(S.rounds)}</th><th>${esc(S.th_wins)}</th></tr></thead><tbody>
      ${s.maps.map((m) => `<tr><td>${mapLink(m.map)}</td><td>${int(m.rounds)}</td><td>${Math.round(100 * m.wins / Math.max(m.rounds, 1))}%</td></tr>`).join("")}
      </tbody></table></div><p class="muted small">${esc(S.maps_help)}</p></section>` : "";
    $("#stBox").innerHTML = head + kpis + perf + last + maps;
    const sel = $("#stCmp");
    if (sel) sel.addEventListener("change", () => { SEL = sel.value; PRO = null; render(s, pop); });
    root.querySelectorAll("[data-pro]").forEach((b) => b.addEventListener("click", () => { PRO = PRO === b.dataset.pro ? null : b.dataset.pro; render(s, pop); }));
  }
})();
