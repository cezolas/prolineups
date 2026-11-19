// "Minha FACEIT": the signed-in user's FACEIT profile, lifetime/per-map stats and last matches (from /api/faceit).
(() => {
  const root = document.getElementById("fc"); if (!root) return;
  const S = JSON.parse(root.dataset.i18n), lang = root.dataset.lang;
  const $ = (s) => root.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v, n = 2) => (v == null || isNaN(v) ? "–" : (+v).toFixed(n).replace(".", S.dec));
  const date = (t) => (t ? new Date(t * 1000).toLocaleDateString(lang === "pt" ? "pt-BR" : "en-GB") : "");
  const mapLink = (label) => {
    const key = String(label || "").toLowerCase().replace(/^de_/, "");
    const m = S.maps[key];
    return m ? `<a href="${m}">${esc(label.replace(/^de_/, ""))}</a>` : esc(String(label || "").replace(/^de_/, ""));
  };

  // ---- "Nota Pronades" on FACEIT stats: the same scale as the pros in our demos (pipeline/perf.py, /dados/perf-pop.json)
  const popP = fetch("/dados/perf-pop.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const CATS = { fragging: [["kpr", .65], ["multi_r", .35]], opening: [["ok_r", .55], ["od_win", .45]],
                 closing: [["clutch_r", 1]], sniping: [["snipe_r", 1]], utility: [["nades_r", .5], ["eb_r", .5]] };
  function metrics(ms) {   // ms: matches with extended stats (x) -> per-round metrics
    const t = { r: 0, k: 0, d: 0, fk: 0, ec: 0, ew: 0, c: 0, sk: 0, uc: 0, ef: 0, mk: 0 };
    for (const m of ms) {
      t.r += m.rounds; t.k += m.k || 0; t.d += m.d || 0; t.fk += m.x.fk; t.ec += m.x.ec; t.ew += m.x.ew;
      t.c += m.x.c1 + m.x.c2; t.sk += m.x.sk; t.uc += m.x.uc; t.ef += m.x.ef; t.mk += m.x.mk;
    }
    const r = Math.max(t.r, 1), od = Math.max(t.ec - t.ew, 0);
    return { rounds: t.r, kpr: t.k / r, multi_r: t.mk / r, ok_r: t.fk / r, od_win: t.ec ? t.ew / t.ec : .5,
             clutch_r: t.c / r, snipe_r: t.sk / r, nades_r: t.uc / r, eb_r: t.ef / r, surv: 1 - t.d / r, open_net: (t.ew - od) / r };
  }
  function pct(pop, k, v) {
    const xs = pop.dist[k] || []; if (!xs.length) return 50;
    if (v <= 0 && k !== "open_net") return 0;
    let lo = 0, hi = 0; for (const x of xs) { if (x < v) lo++; if (x <= v) hi++; }
    return 100 * (lo + hi) / 2 / xs.length;
  }
  function profile(pop, m) {
    const ratio = (k) => (pop.mean[k] ? m[k] / pop.mean[k] : 1);
    const rating = (.35 * ratio("kpr") + .25 * ratio("surv") + .15 * ratio("multi_r")
                    + .15 * (1 + 2.5 * (m.open_net - (pop.mean.open_net || 0)))) / .9;   // no trades on FACEIT: weights renormalized
    const cats = {};
    for (const [c, ws] of Object.entries(CATS)) cats[c] = Math.round(ws.reduce((a, [k, w]) => a + pct(pop, k, m[k]) * w, 0));
    return { rating, cats };
  }
  function card(pf, based) {
    const r = pf.rating, cls = r >= 1.1 ? "good" : r < .9 ? "bad" : "";
    return `<div class="perf-card"><div class="perf-rating" title="${esc(S.perf_help)}"><span>${esc(S.rating)}</span><b class="${cls}">${num(r)}</b></div>
      ${Object.keys(CATS).map((c) => { const v = pf.cats[c];
        return `<div class="perf-row" title="${esc(S.tips[c])}"><span>${esc(S.cats[c])}</span><b>${v}<small>/100</small></b>
          <i class="perf-bar"><i style="width:${v}%" class="${v >= 70 ? "hi" : v < 30 ? "lo" : ""}"></i></i></div>`; }).join("")}
      <div class="muted small perf-based">${esc(based)}</div></div>`;
  }

  fetch("/api/faceit").then(async (r) => {
    $("#fcLoading").hidden = true;
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { $("#fcOut").hidden = false; return; }
    if (r.status === 404) { $("#fcLink").hidden = false; return; }
    if (!r.ok || !j.faceit) { $("#fcOutBox").innerHTML = `<p class="muted">${esc(S.error)}</p>`; return; }
    render(j.faceit, await popP);
  }).catch(() => { $("#fcLoading").hidden = true; $("#fcOutBox").innerHTML = `<p class="muted">${esc(S.error)}</p>`; });

  function render(f, pop) {
    const ext = (f.matches || []).filter((m) => m.x && m.rounds);
    if (pop) for (const m of ext) m.rating = profile(pop, metrics([m])).rating;
    const L = f.lifetime || {};
    const recent = (L.recent || []).map((x) => `<span class="rr ${x === "1" ? "w" : "l"}">${x === "1" ? S.w : S.l}</span>`).join("");
    const head = `<div class="fc-head">
      ${f.avatar ? `<img src="${esc(f.avatar)}" alt="" width="64" height="64" referrerpolicy="no-referrer">` : ""}
      <div><b class="fc-nick">${esc(f.nickname)}</b>
        <div class="muted small">${f.level ? `<span class="fc-lvl lvl-${f.level}">${esc(S.level)} ${f.level}</span>` : ""} ${f.elo ? `· ${f.elo} ELO` : ""} ${f.country ? `· ${esc(String(f.country).toUpperCase())}` : ""}</div>
        <div class="fc-recent">${recent}</div></div></div>`;
    const kpis = `<div class="kpis">
      <div class="kpi"><div class="kpi-v">${L.matches ?? "–"}</div><div class="kpi-l">${esc(S.k_matches)}</div></div>
      <div class="kpi"><div class="kpi-v">${L.winrate ?? "–"}%</div><div class="kpi-l">${esc(S.k_winrate)}</div></div>
      <div class="kpi"><div class="kpi-v">${num(L.kd)}</div><div class="kpi-l">K/D</div></div>
      <div class="kpi"><div class="kpi-v">${L.hs ?? "–"}%</div><div class="kpi-l">HS%</div></div>
      <div class="kpi"><div class="kpi-v">${L.streak ?? "–"}</div><div class="kpi-l">${esc(S.k_streak)}</div></div></div>`;
    const maps = (f.maps || []).length ? `<section><h2>${esc(S.maps_h)}</h2><div class="table-wrap"><table class="uses an-table">
      <thead><tr><th>${esc(S.th_map)}</th><th>${esc(S.k_matches)}</th><th>${esc(S.k_winrate)}</th><th>K/D</th><th>HS%</th></tr></thead><tbody>
      ${f.maps.map((m) => `<tr><td>${mapLink(m.map)}</td><td>${m.matches}</td><td>${m.winrate ?? "–"}%</td><td>${num(m.kd)}</td><td>${m.hs ?? "–"}%</td></tr>`).join("")}
      </tbody></table></div><p class="muted small">${esc(S.maps_help)}</p></section>` : "";
    const ms = (f.matches || []).length ? `<section><h2>${esc(S.matches_h)}</h2><div class="table-wrap"><table class="uses an-table">
      <thead><tr><th>${esc(S.th_date)}</th><th>${esc(S.th_map)}</th><th>${esc(S.th_result)}</th><th>K–D–A</th><th>K/D</th><th>ADR</th><th>HS%</th><th>${esc(S.th_rating)}</th><th></th></tr></thead><tbody>
      ${f.matches.map((m) => `<tr><td>${date(m.at)}</td><td>${mapLink(m.map)}</td>
        <td>${m.won == null ? "–" : `<span class="badge ${m.won ? "win" : "loss"}">${m.won ? S.won : S.lost}</span>`} <span class="muted small">${esc(m.score || "")}</span></td>
        <td>${m.k ?? "–"}–${m.d ?? "–"}–${m.a ?? "–"}</td><td>${num(m.kd)}</td><td>${m.adr ? num(m.adr, 0) : "–"}</td><td>${m.hs ?? "–"}%</td>
        <td>${m.rating != null ? `<b class="${m.rating >= 1.1 ? "good" : m.rating < .9 ? "bad" : ""}">${num(m.rating)}</b>` : "–"}</td>
        <td><a class="btn small" href="https://www.faceit.com/${lang === "pt" ? "pt" : "en"}/cs2/room/${esc(m.id)}" target="_blank" rel="noopener">${esc(S.open_room)}</a></td></tr>`).join("")}
      </tbody></table></div>
      <p class="muted small">${esc(S.demo_help)} <a href="/${lang}/${S.compare_path}/">${esc(S.compare_link)} →</a></p></section>` : "";
    let perf = "";
    if (pop && ext.length) {
      const m = metrics(ext);
      perf = `<section class="perf-sec"><h2>${esc(S.perf_h)}</h2>
        ${card(profile(pop, m), S.perf_based.replace("{m}", ext.length).replace("{r}", m.rounds))}
        <p class="muted small">${esc(S.perf_help)}</p></section>`;
    } else if (pop && (f.matches || []).length) {
      perf = `<section class="perf-sec"><h2>${esc(S.perf_h)}</h2><p class="muted">${esc(S.no_perf)}</p></section>`;
    }
    $("#fcOutBox").innerHTML = head + kpis + perf + maps + ms;
  }
})();
