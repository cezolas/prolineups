// Analytics: every round of the pro matches, filtered and aggregated in the browser (no server, no cookies).
(() => {
  const root = document.getElementById("an"); if (!root) return;
  const S = JSON.parse(root.dataset.i18n), L = root.dataset.l, P = JSON.parse(root.dataset.paths);
  const $ = s => root.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pct = (a, b) => b ? Math.round(100 * a / b) : null;
  const fmtPct = v => v == null ? "–" : v + "%";
  const dec = (v, n = 1) => v == null || isNaN(v) ? "–" : v.toFixed(n).replace(".", S.dec);
  const clock = s => s == null ? "–" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  let D, C;
  const F = { map: "", team: "", tside: "", opp: "", event: "", match: "", buy_t: "", buy_ct: "", half: "", site: "" };
  const URLKEY = { map: "mapa", team: "time", tside: "lado", opp: "adversario", event: "torneio", match: "partida", buy_t: "compra_tr", buy_ct: "compra_ct", half: "metade", site: "bomb" };

  fetch("/dados/analytics.json").then(r => r.json()).then(d => {
    D = d; C = Object.fromEntries(d.cols.map((c, i) => [c, i]));
    const q = new URLSearchParams(location.search);
    for (const k in F) F[k] = q.get(URLKEY[k]) || "";
    buildFilters(); render();
  });

  function opts(sel, items, all) {
    sel.innerHTML = `<option value="">${esc(all)}</option>` + items.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  }
  function buildFilters() {
    const byName = (a, b) => a[1].localeCompare(b[1]);
    opts($("[data-f=map]"), D.maps.map((m, i) => [String(i), m.name]).sort(byName), S.all_maps);
    const teams = D.teams.map((t, i) => [String(i), t.name]).sort(byName);
    opts($("[data-f=team]"), teams, S.all_teams);
    opts($("[data-f=opp]"), teams, S.all_opps);
    opts($("[data-f=event]"), D.events.map((e, i) => [String(i), e.name]), S.all_events);
    opts($("[data-f=match]"), D.matches.map((m, i) => [String(i), `${m.label} · ${D.maps[m.map].name}`]), S.all_matches);
    opts($("[data-f=buy_t]"), D.buys.map((b, i) => [String(i), S.buy[b]]), S.buy_t_all);
    opts($("[data-f=buy_ct]"), D.buys.map((b, i) => [String(i), S.buy[b]]), S.buy_ct_all);
    root.querySelectorAll("[data-f]").forEach(el => { el.value = F[el.dataset.f]; });
    root.addEventListener("change", e => {
      const el = e.target.closest("[data-f]"); if (!el) return;
      F[el.dataset.f] = el.value; render();
    });
    root.addEventListener("click", e => {
      const a = e.target.closest("[data-set]"); if (a) { e.preventDefault(); const [k, v] = a.dataset.set.split("="); F[k] = v; syncSelects(); render(); return; }
      if (e.target.closest("[data-act=reset]")) { for (const k in F) F[k] = ""; syncSelects(); render(); }
    });
  }
  const syncSelects = () => root.querySelectorAll("[data-f]").forEach(el => { el.value = F[el.dataset.f]; });

  function rows() {
    const t = F.team === "" ? null : +F.team, o = F.opp === "" ? null : +F.opp;
    return D.rows.filter(r => {
      if (F.map !== "" && r[C.map] !== +F.map) return false;
      if (F.event !== "" && r[C.event] !== +F.event) return false;
      if (F.match !== "" && r[C.match] !== +F.match) return false;
      if (t !== null) {
        if (F.tside === "T" ? r[C.t] !== t : F.tside === "CT" ? r[C.ct] !== t : r[C.t] !== t && r[C.ct] !== t) return false;
      }
      if (o !== null) {
        const other = t === null ? null : (r[C.t] === t ? r[C.ct] : r[C.t]);
        if (t === null ? r[C.t] !== o && r[C.ct] !== o : other !== o) return false;
      }
      if (F.buy_t !== "" && r[C.buy_t] !== +F.buy_t) return false;
      if (F.buy_ct !== "" && r[C.buy_ct] !== +F.buy_ct) return false;
      if (F.half === "1" && r[C.round] > 12) return false;
      if (F.half === "2" && (r[C.round] <= 12 || r[C.round] > 24)) return false;
      if (F.half === "ot" && r[C.round] <= 24) return false;
      if (F.site === "none" && r[C.site] !== 0) return false;
      if (F.site === "planted" && r[C.site] === 0) return false;
      if (F.site === "A" && r[C.site] !== 1) return false;
      if (F.site === "B" && r[C.site] !== 2) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------- widgets
  const kpi = (label, value, sub = "") => `<div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${esc(label)}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ""}</div>`;
  const bar = (label, v, text, cls = "", n = null) => `<div class="hb"><span class="hb-l">${label}</span><span class="hb-t"><span class="hb-f ${cls}" style="width:${Math.max(0, Math.min(100, v ?? 0))}%"></span></span><span class="hb-v">${text}${n != null ? ` <small>(${n})</small>` : ""}</span></div>`;
  const split = (a, b, la, lb, ca = "t", cb = "ct") => {
    const tot = a + b, pa = pct(a, tot) ?? 0;
    return `<div class="split"><span class="sp-${ca}" style="width:${pa}%">${tot ? `${la} ${pa}%` : ""}</span><span class="sp-${cb}" style="width:${100 - pa}%">${tot ? `${lb} ${100 - pa}%` : ""}</span></div>`;
  };
  const card = (title, body, help = "") => `<section class="an-card"><h3>${esc(title)}</h3>${help ? `<p class="muted small">${esc(help)}</p>` : ""}${body}</section>`;

  function render() {
    const p = new URLSearchParams();
    for (const k in F) if (F[k]) p.set(URLKEY[k], F[k]);
    history.replaceState(null, "", p.toString() ? "?" + p : location.pathname);
    $("[data-f=tside]").disabled = F.team === "";
    const R = rows(), n = R.length;
    $("#anCount").textContent = S.rounds_n.replace("{n}", n);
    if (!n) { $("#anOut").innerHTML = `<p class="muted">${esc(S.empty)}</p>`; return; }
    const tw = R.filter(r => r[C.win] === 0).length;
    const planted = R.filter(r => r[C.site] > 0), pA = planted.filter(r => r[C.site] === 1), pB = planted.filter(r => r[C.site] === 2);
    const conv = planted.filter(r => r[C.win] === 0).length;
    const pistols = R.filter(r => r[C.buy_t] === 0 || r[C.buy_ct] === 0);
    const fkR = R.filter(r => r[C.fk] != null), fkWin = fkR.filter(r => r[C.fk] === r[C.win]).length;
    const uT = R.reduce((s, r) => s + r[C.u_t].reduce((a, b) => a + b, 0), 0) / n, uC = R.reduce((s, r) => s + r[C.u_ct].reduce((a, b) => a + b, 0), 0) / n;
    const plantTimes = planted.map(r => r[C.plant_s]).filter(v => v != null).sort((a, b) => a - b);
    let html = "";

    // team perspective
    if (F.team !== "") {
      const t = +F.team, mine = r => (r[C.t] === t && r[C.win] === 0) || (r[C.ct] === t && r[C.win] === 1);
      const asT = R.filter(r => r[C.t] === t), asC = R.filter(r => r[C.ct] === t);
      const tm = D.teams[t];
      html += `<div class="kpis team-kpis">` +
        kpi(S.team_win.replace("{t}", tm.name), fmtPct(pct(R.filter(mine).length, n)), S.of_rounds.replace("{n}", n)) +
        kpi(S.team_win_t, fmtPct(pct(asT.filter(mine).length, asT.length)), S.of_rounds.replace("{n}", asT.length)) +
        kpi(S.team_win_ct, fmtPct(pct(asC.filter(mine).length, asC.length)), S.of_rounds.replace("{n}", asC.length)) +
        kpi(S.team_plants, fmtPct(pct(asT.filter(r => r[C.site] > 0).length, asT.length)), S.team_plants_sub) +
        kpi(S.team_retake, fmtPct(pct(asC.filter(r => r[C.site] > 0 && r[C.win] === 1).length, asC.filter(r => r[C.site] > 0).length)), S.team_retake_sub) +
        (tm.url ? `<a class="kpi kpi-link" href="${L}/${P.team}/${tm.slug}/">${esc(S.team_page)} →</a>` : "") + `</div>`;
    }

    html += `<div class="kpis">` +
      kpi(S.k_rounds, n) +
      kpi(S.k_t_win, fmtPct(pct(tw, n)), split(tw, n - tw, S.side_t, S.side_ct)) +
      kpi(S.k_plants, fmtPct(pct(planted.length, n)), planted.length ? `A ${pct(pA.length, planted.length)}% · B ${pct(pB.length, planted.length)}%` : "") +
      kpi(S.k_conv, fmtPct(pct(conv, planted.length)), S.k_conv_sub) +
      kpi(S.k_plant_time, clock(plantTimes[plantTimes.length >> 1]), S.k_plant_time_sub) +
      kpi(S.k_fk, fmtPct(pct(fkWin, fkR.length)), S.k_fk_sub) +
      kpi(S.k_pistol, fmtPct(pct(pistols.filter(r => r[C.win] === 0).length, pistols.length)), S.k_pistol_sub.replace("{n}", pistols.length)) +
      kpi(S.k_util, `${dec(uT)} / ${dec(uC)}`, S.k_util_sub) + `</div>`;

    html += `<div class="an-grid">`;
    // how rounds end
    const reasons = D.reasons.map((rs, i) => [rs, R.filter(r => r[C.reason] === i).length]).filter(x => x[1]);
    html += card(S.c_reasons, reasons.map(([rs, c]) => bar(esc(S.reason[rs] || rs), pct(c, n), fmtPct(pct(c, n)), S.reason_side[rs] === "T" ? "f-t" : "f-ct", c)).join(""));
    // bomb sites
    const siteRow = (lab, list) => bar(lab, pct(list.length, planted.length), fmtPct(pct(list.length, planted.length)), "f-acc", list.length) +
      bar(`&nbsp;&nbsp;${esc(S.after_plant)}`, pct(list.filter(r => r[C.win] === 0).length, list.length), fmtPct(pct(list.filter(r => r[C.win] === 0).length, list.length)), "f-t");
    html += card(S.c_sites, planted.length ? siteRow(S.site_a, pA) + siteRow(S.site_b, pB) +
      bar(esc(S.no_plant), pct(n - planted.length, n), fmtPct(pct(n - planted.length, n)), "f-muted", n - planted.length) : `<p class="muted">${esc(S.no_data)}</p>`, S.c_sites_help);
    // economy
    const ecoT = D.buys.map((b, i) => { const l = R.filter(r => r[C.buy_t] === i); return bar(esc(S.buy[b]), pct(l.filter(r => r[C.win] === 0).length, l.length), fmtPct(pct(l.filter(r => r[C.win] === 0).length, l.length)), "f-t", l.length); }).join("");
    const ecoC = D.buys.map((b, i) => { const l = R.filter(r => r[C.buy_ct] === i); return bar(esc(S.buy[b]), pct(l.filter(r => r[C.win] === 1).length, l.length), fmtPct(pct(l.filter(r => r[C.win] === 1).length, l.length)), "f-ct", l.length); }).join("");
    html += card(S.c_eco, `<h4>${esc(S.eco_t)}</h4>${ecoT}<h4>${esc(S.eco_ct)}</h4>${ecoC}`, S.c_eco_help);
    // opening kill
    const fkT = R.filter(r => r[C.fk] === 0), fkC = R.filter(r => r[C.fk] === 1);
    const fkTimes = fkR.map(r => r[C.fk_s]).sort((a, b) => a - b);
    html += card(S.c_fk, split(fkT.length, fkC.length, S.side_t, S.side_ct) +
      bar(esc(S.fk_t_win), pct(fkT.filter(r => r[C.win] === 0).length, fkT.length), fmtPct(pct(fkT.filter(r => r[C.win] === 0).length, fkT.length)), "f-t", fkT.length) +
      bar(esc(S.fk_ct_win), pct(fkC.filter(r => r[C.win] === 1).length, fkC.length), fmtPct(pct(fkC.filter(r => r[C.win] === 1).length, fkC.length)), "f-ct", fkC.length) +
      `<p class="muted small">${esc(S.fk_time)}: ${clock(fkTimes[fkTimes.length >> 1])}</p>`, S.c_fk_help);
    // utility vs result
    const typeAvg = (side) => D.util.map((u, i) => `${esc(S.util[u])} ${dec(R.reduce((s, r) => s + r[side][i], 0) / n)}`).join(" · ");
    const buckets = [[0, 1, "0–1"], [2, 3, "2–3"], [4, 99, "4+"]];
    const smokeBars = buckets.map(([a, b, lab]) => { const l = R.filter(r => r[C.u_t][0] >= a && r[C.u_t][0] <= b); return bar(lab + " smokes", pct(l.filter(r => r[C.win] === 0).length, l.length), fmtPct(pct(l.filter(r => r[C.win] === 0).length, l.length)), "f-t", l.length); }).join("");
    html += card(S.c_util, `<p class="small"><b>${esc(S.side_t)}:</b> ${typeAvg(C.u_t)}<br><b>${esc(S.side_ct)}:</b> ${typeAvg(C.u_ct)}</p><h4>${esc(S.util_smokes)}</h4>${smokeBars}`, S.c_util_help);
    // T win by round number
    const byRound = [];
    for (let i = 1; i <= 24; i++) { const l = R.filter(r => r[C.round] === i); byRound.push([i, l.length, l.filter(r => r[C.win] === 0).length]); }
    html += card(S.c_rounds, `<div class="cols24">${byRound.map(([i, c, w]) => `<div class="c24" title="${S.round} ${i}: ${fmtPct(pct(w, c))} (${c})"><span class="c24-b" style="height:${c ? pct(w, c) : 0}%"></span><span class="c24-l">${i}</span></div>`).join("")}</div><p class="muted small">${esc(S.c_rounds_help)}</p>`);
    html += `</div>`;

    // per map table
    if (F.map === "") {
      const maps = D.maps.map((m, i) => [m, R.filter(r => r[C.map] === i)]).filter(x => x[1].length).sort((a, b) => b[1].length - a[1].length);
      html += card(S.t_maps, table([S.th_map, S.th_rounds, S.th_t, S.th_ct, S.th_plant, "A / B", S.th_conv], maps.map(([m, l]) => {
        const pl = l.filter(r => r[C.site] > 0), a = pl.filter(r => r[C.site] === 1).length, tw2 = l.filter(r => r[C.win] === 0).length;
        return [`<a href="#" data-set="map=${D.maps.indexOf(m)}">${esc(m.name)}</a>`, l.length, fmtPct(pct(tw2, l.length)), fmtPct(pct(l.length - tw2, l.length)),
          fmtPct(pct(pl.length, l.length)), pl.length ? `${pct(a, pl.length)}% / ${100 - pct(a, pl.length)}%` : "–", fmtPct(pct(pl.filter(r => r[C.win] === 0).length, pl.length))];
      })));
    }
    // per team table
    const teamRows = D.teams.map((tm, i) => {
      const l = R.filter(r => r[C.t] === i || r[C.ct] === i); if (!l.length) return null;
      const win = l.filter(r => (r[C.t] === i && r[C.win] === 0) || (r[C.ct] === i && r[C.win] === 1)).length;
      const asT = l.filter(r => r[C.t] === i), asC = l.filter(r => r[C.ct] === i), pl = asT.filter(r => r[C.site] > 0), a = pl.filter(r => r[C.site] === 1).length;
      const fk = l.filter(r => r[C.fk] != null), fkMine = fk.filter(r => (r[C.t] === i && r[C.fk] === 0) || (r[C.ct] === i && r[C.fk] === 1)).length;
      const pis = l.filter(r => r[C.buy_t] === 0 || r[C.buy_ct] === 0), pisW = pis.filter(r => (r[C.t] === i && r[C.win] === 0) || (r[C.ct] === i && r[C.win] === 1)).length;
      const util = l.reduce((s, r) => s + (r[C.t] === i ? r[C.u_t] : r[C.u_ct]).reduce((x, y) => x + y, 0), 0) / l.length;
      const fl = tm.flag ? `<img class="flag" src="/static/flags/${tm.flag}.svg" alt="" width="16" height="12"> ` : "";
      return [l.length, [`${fl}<a href="#" data-set="team=${i}">${esc(tm.name)}</a>`, l.length, fmtPct(pct(win, l.length)),
        fmtPct(pct(asT.filter(r => r[C.win] === 0).length, asT.length)), fmtPct(pct(asC.filter(r => r[C.win] === 1).length, asC.length)),
        fmtPct(pct(pisW, pis.length)), fmtPct(pct(pl.length, asT.length)), pl.length ? `${pct(a, pl.length)}% / ${100 - pct(a, pl.length)}%` : "–",
        fmtPct(pct(fkMine, fk.length)), dec(util)]];
    }).filter(Boolean).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    html += card(S.t_teams, table([S.th_team, S.th_rounds, S.th_win, S.th_t, S.th_ct, S.th_pistol, S.th_plant_t, "A / B", S.th_fk, S.th_util], teamRows), S.t_teams_help);
    // matches list
    const ms = [...new Set(R.map(r => r[C.match]))].map(i => [i, R.filter(r => r[C.match] === i)]);
    html += card(S.t_matches, table([S.th_match, S.th_map, S.th_date, S.th_rounds, S.th_t, S.th_plant], ms.map(([i, l]) => {
      const m = D.matches[i];
      return [`<a href="#" data-set="match=${i}">${esc(m.label)}</a>`, esc(D.maps[m.map].name), esc(m.date || ""), l.length,
        fmtPct(pct(l.filter(r => r[C.win] === 0).length, l.length)), fmtPct(pct(l.filter(r => r[C.site] > 0).length, l.length))];
    })));
    $("#anOut").innerHTML = html;
  }

  function table(head, body) {
    return `<div class="table-wrap"><table class="uses an-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
      `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
})();
