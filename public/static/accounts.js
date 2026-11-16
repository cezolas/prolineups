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

  // ---------------------------------------------------------------- activity log (signed-in users only; see privacy policy)
  // events wait until we know the visitor is signed in; anonymous visits are never sent
  const lang = document.documentElement.lang.startsWith("pt") ? "pt" : "en";
  let queue = [], meKnown = false, seenVideo = new Set();
  const flush = () => {
    if (!PN.me || !queue.length) return;
    const body = JSON.stringify(queue.splice(0, 10));
    if (!(navigator.sendBeacon && navigator.sendBeacon("/api/log", new Blob([body], { type: "application/json" }))))
      fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    if (queue.length) flush();
  };
  PN.log = (k, d) => {
    if (meKnown && !PN.me) return;
    queue.push({ k, p: location.pathname, d: d ? String(d).slice(0, 200) : undefined, l: lang });
    if (meKnown) flush();
  };
  PN.log("page", document.title.split(" · ")[0]);
  document.addEventListener("play", (e) => {
    const v = e.target; if (!(v instanceof HTMLVideoElement)) return;
    const src = (v.currentSrc || v.src || "").split("?")[0].split("/").pop();
    if (src && !src.startsWith("blob:") && !seenVideo.has(src)) { seenVideo.add(src); PN.log("video", src); }
  }, true);
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy], [data-copycmd]");
    if (c) return PN.log("copy", document.querySelector(".mm-detail h2, h1")?.textContent?.trim());
    const a = e.target.closest('a[href$=".cfg"], a[download]');
    if (a) return PN.log("download", a.getAttribute("href"));
    const f = e.target.closest("#favBtn, [data-fav]");
    if (f) PN.log("fav", (() => { try { return JSON.parse(f.dataset.fav || "{}").name; } catch (x) { return ""; } })());
  }, true);
  document.addEventListener("change", (e) => {
    const i = e.target; if (!(i instanceof HTMLInputElement) || i.type !== "file" || !i.files || !i.files[0]) return;
    const fl = i.files[0];  // never the file name: only its type and size
    PN.log("demo", `${(fl.name.match(/\.(dem(\.(zst|gz|bz2))?|zip|gz|zst)$/i) || ["?"])[0].toLowerCase()} · ${(fl.size / 1048576).toFixed(0)} MB`);
  }, true);
  document.addEventListener("pn:me", () => { meKnown = true; if (PN.me) flush(); else queue = []; });
  addEventListener("pagehide", flush);

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
      login.href = `/${document.documentElement.lang.startsWith("pt") ? "pt" : "en"}/${login.dataset.account}/?next=${encodeURIComponent(location.pathname)}`;
      PN.loginOptions = { google: j.google !== false, faceit: !!j.faceit_login };
      document.dispatchEvent(new CustomEvent("pn:me", { detail: null }));
    } else {
      document.dispatchEvent(new CustomEvent("pn:me", { detail: null }));
    }
  }).catch(() => document.dispatchEvent(new CustomEvent("pn:me", { detail: null })));
})();
