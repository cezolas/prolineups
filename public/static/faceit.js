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

  fetch("/api/faceit").then(async (r) => {
    $("#fcLoading").hidden = true;
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { $("#fcOut").hidden = false; return; }
    if (r.status === 404) { $("#fcLink").hidden = false; return; }
    if (!r.ok || !j.faceit) { $("#fcOutBox").innerHTML = `<p class="muted">${esc(S.error)}</p>`; return; }
    render(j.faceit);
  }).catch(() => { $("#fcLoading").hidden = true; $("#fcOutBox").innerHTML = `<p class="muted">${esc(S.error)}</p>`; });

  function render(f) {
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
      <thead><tr><th>${esc(S.th_date)}</th><th>${esc(S.th_map)}</th><th>${esc(S.th_result)}</th><th>K–D–A</th><th>K/D</th><th>ADR</th><th>HS%</th><th></th></tr></thead><tbody>
      ${f.matches.map((m) => `<tr><td>${date(m.at)}</td><td>${mapLink(m.map)}</td>
        <td>${m.won == null ? "–" : `<span class="badge ${m.won ? "win" : "loss"}">${m.won ? S.won : S.lost}</span>`} <span class="muted small">${esc(m.score || "")}</span></td>
        <td>${m.k ?? "–"}–${m.d ?? "–"}–${m.a ?? "–"}</td><td>${num(m.kd)}</td><td>${m.adr ? num(m.adr, 0) : "–"}</td><td>${m.hs ?? "–"}%</td>
        <td><a class="btn small" href="https://www.faceit.com/${lang === "pt" ? "pt" : "en"}/cs2/room/${esc(m.id)}" target="_blank" rel="noopener">${esc(S.open_room)}</a></td></tr>`).join("")}
      </tbody></table></div>
      <p class="muted small">${esc(S.demo_help)} <a href="/${lang}/${S.compare_path}/">${esc(S.compare_link)} →</a></p></section>` : "";
    $("#fcOutBox").innerHTML = head + kpis + maps + ms;
  }
})();
