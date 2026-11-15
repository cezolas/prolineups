// Accounts (Google login): shows "Sign in" / avatar in the header and keeps favourites + training-plan progress in sync
// with the account. Works without an account too (everything stays in this browser).
(() => {
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
               keys: () => { try { return Object.keys(localStorage); } catch (e) { return []; } } };
  const login = document.getElementById("loginBtn"), meBtn = document.getElementById("meBtn");
  const PN = (window.PN = { me: null, push: () => {} });

  const put = (key, data) => fetch(`/api/data/${key}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).catch(() => {});
  const get = (key) => fetch(`/api/data/${key}`).then((r) => (r.ok ? r.json() : { data: null })).then((j) => j.data).catch(() => null);
  const favKey = (u) => String(u || "").replace(/^\/[a-z]{2}\//, "/");
  const localFavs = () => { try { return JSON.parse(ls.get("favs") || "[]"); } catch (e) { return []; } };
  const localPlan = () => Object.fromEntries(ls.keys().filter((k) => k.startsWith("plan:") || k === "planPrefs").map((k) => [k, ls.get(k)]));

  let timers = {};
  PN.push = (key) => {
    if (!PN.me) return;
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => put(key, key === "favs" ? localFavs() : localPlan()), 600);
  };

  async function sync() {
    // favourites: union (server first, then anything new saved in this browser)
    const sf = (await get("favs")) || [], lf = localFavs(), seen = new Set(), favs = [];
    for (const f of [...sf, ...lf]) { const k = favKey(f.url); if (!seen.has(k)) { seen.add(k); favs.push(f); } }
    ls.set("favs", JSON.stringify(favs));
    // training plan: per checklist, ticks from both sides
    const sp = (await get("plan")) || {}, lp = localPlan();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "planPrefs") { if (!lp[k]) ls.set(k, v); continue; }
      let a = {}, b = {};
      try { a = JSON.parse(v || "{}") || {}; b = JSON.parse(lp[k] || "{}") || {}; } catch (e) {}
      const merged = { ...a };
      for (const [x, on] of Object.entries(b)) if (on) merged[x] = true;
      ls.set(k, JSON.stringify(merged));
    }
    await Promise.all([put("favs", favs), put("plan", localPlan())]);
    document.dispatchEvent(new CustomEvent("pn:synced"));
  }

  fetch("/api/me").then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.user) {
      PN.me = j.user;
      if (meBtn) {
        meBtn.hidden = false;
        const img = meBtn.querySelector("img");
        if (j.user.picture && img) { img.src = j.user.picture; img.hidden = false; }
        meBtn.title = j.user.name || j.user.email || "";
      }
      document.dispatchEvent(new CustomEvent("pn:me", { detail: j.user }));
      sync();
    } else if (r.status === 401 && j.configured !== false && login) {
      login.hidden = false;
      login.href = `/auth/google?next=${encodeURIComponent(location.pathname)}`;
      document.dispatchEvent(new CustomEvent("pn:me", { detail: null }));
    } else {
      document.dispatchEvent(new CustomEvent("pn:me", { detail: null }));
    }
  }).catch(() => document.dispatchEvent(new CustomEvent("pn:me", { detail: null })));
})();
