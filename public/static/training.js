// Weekly training plan: map + side + grenades per day -> 6 days of new lineups (easiest first) + 1 review day.
// Checklist kept in this browser; each day downloads its own .cfg (lp_next / lp_prev) for an offline server.
(() => {
  const root = document.getElementById("plan"); if (!root) return;
  const S = JSON.parse(root.dataset.i18n), lang = root.dataset.lang;
  const $ = s => root.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = { get: k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  let D = null;
  const pref = store.get("planPrefs") || {};
  fetch(`/dados/treino-${lang}.json`).then(r => r.json()).then(d => {
    D = d;
    $("[data-p=map]").innerHTML = d.maps.map(m => `<option value="${m.slug}">${esc(m.name)}</option>`).join("");
    if (pref.map) $("[data-p=map]").value = pref.map;
    if (pref.side) $("[data-p=side]").value = pref.side;
    if (pref.per) $("[data-p=per]").value = pref.per;
    render();
  });
  root.addEventListener("change", e => {
    if (e.target.closest("[data-p]")) { store.set("planPrefs", { map: $("[data-p=map]").value, side: $("[data-p=side]").value, per: $("[data-p=per]").value }); render(); }
    const c = e.target.closest("[data-done]");
    if (c) { const k = key(); const done = store.get(k) || {}; done[c.dataset.done] = c.checked; store.set(k, done); progress(); }
  });
  root.addEventListener("click", e => {
    const b = e.target.closest("[data-cfg]"); if (!b) return;
    const day = plan()[+b.dataset.cfg];
    const blob = new Blob([cfg(day, +b.dataset.cfg + 1)], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `lineupspro_${$("[data-p=map]").value}_${S.day_file}${+b.dataset.cfg + 1}.cfg`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const key = () => `plan:${$("[data-p=map]").value}:${$("[data-p=side]").value}:${$("[data-p=per]").value}`;

  function plan() {
    const m = D.maps.find(x => x.slug === $("[data-p=map]").value), side = $("[data-p=side]").value, per = +$("[data-p=per]").value;
    const pool = m.lineups.filter(l => !side || l.side === side).sort((a, b) => b.count - a.count).slice(0, per * 6)
      .sort((a, b) => a.diff - b.diff || b.count - a.count);
    const days = [];
    for (let i = 0; i < 6; i++) days.push(pool.slice(i * per, (i + 1) * per));
    // review day: the hardest one of each previous day
    days.push(days.map(d => d[d.length - 1]).filter(Boolean).slice(0, Math.max(per, 5)));
    return days.filter(d => d.length);
  }
  function render() {
    if (!D) return;
    const days = plan(), done = store.get(key()) || {};
    $("#planDays").innerHTML = days.map((d, i) => `
      <section class="pd"><h3>${i === days.length - 1 && days.length === 7 ? esc(S.review) : esc(S.day.replace("{n}", i + 1))}
        <button class="btn small" data-cfg="${i}" type="button">⬇ ${esc(S.cfg)}</button></h3>
        <ul>${d.map(l => `<li><label><input type="checkbox" data-done="${i}:${l.id}"${done[`${i}:${l.id}`] ? " checked" : ""}>
          <a href="${l.url}">${esc(l.name)}</a></label>
          <span class="badge diff-${l.diff}">${esc(S.diff[l.diff])}</span><span class="badge side-${l.side}">${esc(S.side[l.side])}</span>
          <span class="muted small">${esc(l.tech || "")}</span></li>`).join("")}</ul></section>`).join("");
    progress();
  }
  function progress() {
    const all = root.querySelectorAll("[data-done]"), ok = [...all].filter(c => c.checked).length;
    $("#planProg").textContent = S.progress.replace("{a}", ok).replace("{b}", all.length);
    $("#planBar").style.width = (all.length ? 100 * ok / all.length : 0) + "%";
  }
  function cfg(items, n) {
    const L = [`// Lineups Pro - ${S.cfg_title} ${n} (${items.length} lineups)`, "sv_cheats 1; sv_infinite_ammo 1; ammo_grenade_limit_total 5; sv_grenade_trajectory_prac_pipreview 1",
      "mp_warmup_end; mp_freezetime 0; mp_roundtime_defuse 60; mp_buy_anywhere 1; mp_buytime 9999; bot_kick",
      "give weapon_smokegrenade; give weapon_flashbang; give weapon_hegrenade; give weapon_molotov; give weapon_incgrenade", ""];
    items.forEach((l, i) => {
      const nx = (i + 1) % items.length + 1, pv = (i - 1 + items.length) % items.length + 1;
      L.push(`alias lp_${i + 1} "setpos ${l.pos}; setang ${l.ang} 0; echo [${i + 1}/${items.length}] ${l.ascii}; alias lp_next lp_${nx}; alias lp_prev lp_${pv}"`);
    });
    L.push("", "alias lp_next lp_1", `alias lp_prev lp_${items.length}`, `echo ${S.cfg_ready}`, "");
    return L.join("\n");
  }
})();
