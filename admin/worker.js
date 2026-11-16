// Pronades — online Admin (Cloudflare Worker).
// The whole Worker sits behind Cloudflare Access (only the e-mails you allow can log in). As a second lock, every
// request is checked here too: the Access JWT must be valid (signature, issuer, audience, expiry) and the e-mail must
// be in ADMIN_EMAILS, or the request must come from the studio's service token (read-only export).
//
// Storage (KV binding ADMIN):
//   places:<map>  -> { "<ValvePlace>": { "<lang>": { "display": "...", "by": "email", "at": "ISO date" } } }
//   audit         -> last 300 changes [{ at, by, map, place, lang, display }]
//
// API
//   GET  /api/me                -> who is logged in
//   GET  /api/places/<map>      -> De-Para overrides of one map
//   POST /api/places            -> { map, place, lang, display }   (empty display = back to default)
//   GET  /api/audit             -> recent changes
//   GET/POST /api/roadmap, POST /api/roadmap/<id>  -> ideas board (status, notes, priority, delete)
//   GET  /api/export            -> all overrides (used by pipeline/admin_sync.py on the studio PC)
//   GET  /api/reports           -> "report a problem" messages from the site (D1) + likes ranking + removed items
//   POST /api/reports/<id>      -> { status: "open"|"done"|"dismissed" }
//   POST /api/resolve           -> { url } -> the like/report key of a public page (read from the page itself)
//   POST /api/remove            -> { k, title, restore? }  remove a grenade/tactic from the site (or put it back).
//        Hidden right away by the page script (D1 "removed"); the studio pulls KV "removed" and drops it on the next export.
// Everything else is served from ./public (the admin page, radars, place lists).

const MAP_RE = /^[a-z0-9_]{2,40}$/;
const PLACE_RE = /^[A-Za-z0-9_]{1,60}$/;
const ROADMAP_STATUSES = ["ideia", "aprovado", "em_andamento", "revisao", "feito", "descartado"];
let certsCache = { at: 0, keys: [] };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToJson = s => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function accessKeys(cfg) {
  if (Date.now() - certsCache.at < 3600_000 && certsCache.keys.length) return certsCache.keys;
  const r = await fetch(`https://${cfg.team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("não consegui ler as chaves do Cloudflare Access");
  certsCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return certsCache.keys;
}

// Dashboard values are often pasted with spaces, quotes or "https://": normalise them.
function settings(env) {
  const clean = v => String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
  return {
    team: clean(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    aud: clean(env.ACCESS_AUD),
    // ADMIN_EMAILS (preferred) or ADMIN_EMAIL; both may hold several e-mails separated by commas
    admins: [clean(env.ADMIN_EMAILS), clean(env.ADMIN_EMAIL)].join(",").toLowerCase().split(/[,;\s]+/).filter(Boolean),
    syncId: clean(env.SYNC_CLIENT_ID),
  };
}

// Checks the Cloudflare Access JWT. Returns { identity } or { reason } (why access is denied; never grants anything).
async function verifyAccess(request, cfg) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!cfg.team) return { reason: "a variável ACCESS_TEAM_DOMAIN não está configurada no Worker." };
  if (!token) return { reason: "não chegou nenhum login do Cloudflare Access. O Access não está protegendo este endereço: " +
                                "no Worker, aba Access, escolha \"All traffic\" e uma regra com o seu e-mail." };
  const parts = token.split(".");
  if (parts.length !== 3) return { reason: "login em formato inválido." };
  let header, payload;
  try { header = b64urlToJson(parts[0]); payload = b64urlToJson(parts[1]); } catch { return { reason: "login ilegível." }; }
  if (header.alg !== "RS256") return { reason: "login com algoritmo inesperado." };
  let keys = await accessKeys(cfg);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { certsCache.at = 0; keys = await accessKeys(cfg); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk) return { reason: "o login não foi assinado pelo seu time do Cloudflare (confira ACCESS_TEAM_DOMAIN)." };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
                                        new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return { reason: "assinatura do login inválida." };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return { reason: "login expirado; entre de novo." };
  if (payload.iss !== `https://${cfg.team}`) return { reason: "login emitido por outro time (confira ACCESS_TEAM_DOMAIN)." };
  const aud = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).filter(Boolean);
  // Setup helper: with no ACCESS_AUD yet, a token correctly signed by YOUR team only reveals its audience.
  if (!cfg.aud) return { setup_aud: aud.join(", ") };
  if (!aud.includes(cfg.aud)) return { reason: "o AUD deste login (" + aud.join(", ") + ") é diferente da variável ACCESS_AUD." };
  return { identity: payload };
}

function role(identity, cfg) {
  if (!identity) return null;
  if (identity.email && cfg.admins.includes(String(identity.email).toLowerCase())) return "admin";
  if (identity.common_name && cfg.syncId && identity.common_name === cfg.syncId) return "sync";
  return null;
}

async function knownPlaces(env, request, map) {
  const r = await env.ASSETS.fetch(new Request(new URL(`/lugares/${map}.json`, request.url)));
  if (!r.ok) return null;
  const d = await r.json();
  return { places: new Set((d.places || []).map(p => p.place)), langs: d.langs || ["pt"] };
}

async function readJSON(env, key, fallback) {
  const v = await env.ADMIN.get(key);
  return v ? JSON.parse(v) : fallback;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = settings(env);
    let check;
    try { check = await verifyAccess(request, cfg); } catch (e) { return json({ error: String(e.message || e) }, 503); }
    const identity = check.identity || null;
    if (check.setup_aud) {
      return new Response(
        "Configuração do Admin quase pronta.\n\nNo Cloudflare, abra o Worker prolineups-admin > Settings > Variables and Secrets " +
        "e crie a variável:\n\n  ACCESS_AUD = " + identity.setup_aud + "\n\nDepois recarregue esta página.",
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    const who = role(identity, cfg);
    if (!who) {
      let why = check.reason;
      if (!why && identity) {
        why = identity.email
          ? `o e-mail ${identity.email} não está na variável ADMIN_EMAILS.`
          : `o token de serviço ${identity.common_name || "(sem nome)"} não é o da variável SYNC_CLIENT_ID.`;
      }
      return new Response("Acesso negado. Motivo: " + (why || "desconhecido."), {
        status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }

    if (!url.pathname.startsWith("/api/")) {
      if (who !== "admin") return new Response("Somente leitura.", { status: 403 });
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/export" && request.method === "GET") {
      const maps = {};
      const list = await env.ADMIN.list({ prefix: "places:" });
      for (const k of list.keys) maps[k.name.slice(7)] = await readJSON(env, k.name, {});
      return json({ maps, removed: await readJSON(env, "removed", []), exported_at: new Date().toISOString() });
    }
    if (who !== "admin") return json({ error: "token de sincronização só pode exportar" }, 403);

    if (url.pathname === "/api/me") return json({ email: identity.email });

    if (url.pathname === "/api/audit") return json({ items: await readJSON(env, "audit", []) });

    // ---------------------------------------------------------------- users + activity log (read-only)
    if (url.pathname === "/api/users" && request.method === "GET") {
      if (!env.USERS) return json({ error: "USERS não ligado neste Worker" }, 503);
      const users = [];
      let cursor;
      do {
        const page = await env.USERS.list({ prefix: "user:", cursor, limit: 1000 });
        const vals = await Promise.all(page.keys.map(k => env.USERS.get(k.name, "json")));
        for (const u of vals) if (u) users.push(u);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor && users.length < 5000);
      const stats = {};
      if (env.DB) {
        // keep the log for 180 days (privacy policy)
        await env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(Date.now() - 180 * 864e5).run().catch(() => {});
        const r = await env.DB.prepare(`SELECT sub, COUNT(*) n, MAX(ts) last, SUM(kind='page') pages, SUM(kind='video') videos,
            SUM(kind='copy') copies, SUM(kind='demo') demos, SUM(kind='download') downloads,
            SUM(ts > ?) n7, COUNT(DISTINCT date(ts/1000, 'unixepoch')) days FROM events GROUP BY sub`).bind(Date.now() - 7 * 864e5).all();
        for (const x of r.results || []) stats[x.sub] = x;
        const dev = await env.DB.prepare("SELECT sub, device, COUNT(*) n FROM events GROUP BY sub, device").all();
        for (const x of dev.results || []) { const s = stats[x.sub]; if (s) (s.devices = s.devices || {})[x.device || "?"] = x.n; }
      }
      const out = users.map(u => {
        const faceitOnly = String(u.sub || "").startsWith("faceit:");
        return {
          sub: u.sub, name: u.name, email: u.email, picture: u.picture, created: u.created, last_login: u.last_login,
          type: faceitOnly ? "faceit" : (u.faceit ? "google+faceit" : "google"),
          faceit: u.faceit ? u.faceit.nickname : null, plan: u.plan || "free",
          stats: stats[u.sub] || null,
        };
      });
      out.sort((a, b) => ((b.stats && b.stats.last) || Date.parse(b.last_login || 0) || 0) - ((a.stats && a.stats.last) || Date.parse(a.last_login || 0) || 0));
      let daily = [], top = [];
      if (env.DB) {
        daily = (await env.DB.prepare(`SELECT date(ts/1000, 'unixepoch', '-3 hours') d, COUNT(*) n, COUNT(DISTINCT sub) u,
            SUM(kind='video') v FROM events WHERE ts > ? GROUP BY d ORDER BY d`).bind(Date.now() - 30 * 864e5).all()).results || [];
        top = (await env.DB.prepare(`SELECT path, COUNT(*) n, COUNT(DISTINCT sub) u FROM events WHERE kind='page' AND ts > ?
            GROUP BY path ORDER BY n DESC LIMIT 15`).bind(Date.now() - 30 * 864e5).all()).results || [];
      }
      return json({ users: out, daily, top, log_enabled: !!env.DB });
    }
    const ul = url.pathname.match(/^\/api\/users\/log$/);
    if (ul && request.method === "GET") {
      if (!env.DB) return json({ items: [] });
      const sub = url.searchParams.get("sub"), kind = url.searchParams.get("kind");
      const before = +url.searchParams.get("before") || Date.now() + 1;
      let q = "SELECT id, ts, sub, kind, path, detail, lang, device, country FROM events WHERE ts < ?";
      const args = [before];
      if (sub) { q += " AND sub = ?"; args.push(sub); }
      if (kind) { q += " AND kind = ?"; args.push(kind); }
      q += " ORDER BY ts DESC LIMIT 200";
      const r = await env.DB.prepare(q).bind(...args).all();
      return json({ items: r.results || [] });
    }

    // ---------------------------------------------------------------- reports, likes, removals (D1 shared with the site)
    const REACT_KEY = /^[gep]:[a-z0-9_]{2,40}\/[a-z0-9-]{1,120}$/;
    if (url.pathname.startsWith("/api/reports") || url.pathname === "/api/remove" || url.pathname === "/api/resolve") {
      if (!env.DB) return json({ error: "DB não ligado neste Worker" }, 503);
      await env.DB.batch([
        env.DB.prepare("CREATE TABLE IF NOT EXISTS likes (k TEXT NOT NULL, who TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (k, who))"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, url TEXT, reason TEXT, note TEXT, who TEXT, lang TEXT, ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open')"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS removed (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, by TEXT, title TEXT)"),
      ]);
    }
    if (url.pathname === "/api/reports" && request.method === "GET") {
      const status = url.searchParams.get("status") || "open";
      const reports = (await env.DB.prepare("SELECT id, k, url, reason, note, lang, ts, status FROM reports WHERE status = ? ORDER BY ts DESC LIMIT 300")
        .bind(status).all()).results || [];
      const likes = (await env.DB.prepare("SELECT k, COUNT(*) n FROM likes GROUP BY k ORDER BY n DESC LIMIT 30").all()).results || [];
      const removed = (await env.DB.prepare("SELECT k, ts, by, title FROM removed ORDER BY ts DESC").all()).results || [];
      return json({ reports, likes, removed });
    }
    const rp = url.pathname.match(/^\/api\/reports\/(\d{1,12})$/);
    if (rp && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!["open", "done", "dismissed"].includes(b.status)) return json({ error: "status inválido" }, 400);
      await env.DB.prepare("UPDATE reports SET status = ? WHERE id = ?").bind(b.status, +rp[1]).run();
      return json({ ok: true });
    }
    if (url.pathname === "/api/resolve" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      let u;
      try { u = new URL(String(b.url || "").trim(), cfg.site_url || "https://pronades.com.br"); } catch { return json({ error: "URL inválida" }, 400); }
      if (!/(^|\.)pronades\.com\.br$/.test(u.hostname)) return json({ error: "use um link do pronades.com.br" }, 400);
      const r = await fetch(`https://pronades.com.br${u.pathname}`, { headers: { "user-agent": "pronades-admin" } });
      if (!r.ok) return json({ error: `a página respondeu ${r.status}` }, 400);
      const html = await r.text();
      const k = (html.match(/class="react" data-k="([^"]+)"/) || [])[1];
      const title = ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!k) return json({ error: "essa página não é de uma granada ou tática" }, 400);
      return json({ k, title, path: u.pathname });
    }
    if (url.pathname === "/api/remove" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!REACT_KEY.test(b.k || "")) return json({ error: "chave inválida" }, 400);
      const list = await readJSON(env, "removed", []);
      const rest = list.filter(x => x.k !== b.k);
      if (b.restore) {
        await env.DB.prepare("DELETE FROM removed WHERE k = ?").bind(b.k).run();
        await env.ADMIN.put("removed", JSON.stringify(rest));
        return json({ ok: true, restored: b.k });
      }
      const entry = { k: b.k, title: String(b.title || "").slice(0, 200), by: identity.email, at: new Date().toISOString() };
      await env.DB.prepare("INSERT OR REPLACE INTO removed (k, ts, by, title) VALUES (?, ?, ?, ?)").bind(b.k, Date.now(), entry.by, entry.title).run();
      await env.DB.prepare("UPDATE reports SET status = 'done' WHERE k = ? AND status = 'open'").bind(b.k).run();
      rest.unshift(entry);
      await env.ADMIN.put("removed", JSON.stringify(rest.slice(0, 2000)));
      return json({ ok: true, removed: entry });
    }

    // ---- roadmap: ideas board (KV key "roadmap"); Claude reads/updates it from the studio via the Cloudflare API
    if (url.pathname === "/api/roadmap" && request.method === "GET") {
      return json({ items: await readJSON(env, "roadmap", []), statuses: ROADMAP_STATUSES });
    }
    if (url.pathname === "/api/roadmap" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
      const title = String(body.title || "").trim().slice(0, 140);
      const description = String(body.description || "").trim().slice(0, 4000);
      if (!title) return json({ error: "dê um título para a ideia" }, 400);
      const items = await readJSON(env, "roadmap", []);
      const now = new Date().toISOString();
      const item = { id: crypto.randomUUID().slice(0, 8), title, description, status: "ideia", priority: Number(body.priority) || 2,
                     by: identity.email, at: now, updated_at: now, notes: [] };
      items.unshift(item);
      await env.ADMIN.put("roadmap", JSON.stringify(items.slice(0, 500)));
      return json({ ok: true, item });
    }
    const rm = url.pathname.match(/^\/api\/roadmap\/([a-z0-9-]{4,40})$/);
    if (rm && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
      const items = await readJSON(env, "roadmap", []);
      const item = items.find(x => x.id === rm[1]);
      if (!item) return json({ error: "item não encontrado" }, 404);
      if (body.delete === true) {
        await env.ADMIN.put("roadmap", JSON.stringify(items.filter(x => x.id !== item.id)));
        return json({ ok: true, deleted: item.id });
      }
      if (body.status !== undefined) {
        if (!ROADMAP_STATUSES.includes(body.status)) return json({ error: "status inválido" }, 400);
        item.status = body.status;
      }
      if (body.title !== undefined) item.title = String(body.title).trim().slice(0, 140) || item.title;
      if (body.description !== undefined) item.description = String(body.description).trim().slice(0, 4000);
      if (body.priority !== undefined) item.priority = Math.min(3, Math.max(1, Number(body.priority) || 2));
      if (body.note) item.notes = [...(item.notes || []), { by: identity.email, at: new Date().toISOString(), text: String(body.note).slice(0, 2000) }];
      item.updated_at = new Date().toISOString();
      await env.ADMIN.put("roadmap", JSON.stringify(items));
      return json({ ok: true, item });
    }

    const m = url.pathname.match(/^\/api\/places\/([a-z0-9_]+)$/);
    if (m && request.method === "GET") {
      if (!MAP_RE.test(m[1])) return json({ error: "mapa inválido" }, 400);
      return json({ map: m[1], overrides: await readJSON(env, `places:${m[1]}`, {}) });
    }

    if (url.pathname === "/api/places" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
      const map = String(body.map || ""), place = String(body.place || ""), lang = String(body.lang || "pt");
      const display = String(body.display ?? "").trim().slice(0, 60);
      if (!MAP_RE.test(map) || !PLACE_RE.test(place)) return json({ error: "mapa ou lugar inválido" }, 400);
      const known = await knownPlaces(env, request, map);
      if (!known || !known.places.has(place)) return json({ error: "lugar desconhecido neste mapa" }, 400);
      if (!known.langs.includes(lang)) return json({ error: "idioma não configurado" }, 400);
      const key = `places:${map}`;
      const data = await readJSON(env, key, {});
      const entry = { display, by: identity.email, at: new Date().toISOString() };
      let slot = data[place] || {};
      if (slot.display !== undefined) slot = { pt: slot }; // migrate an old single-language entry
      slot[lang] = entry; // empty display is kept as an explicit "back to default"
      data[place] = slot;
      await env.ADMIN.put(key, JSON.stringify(data));
      const audit = await readJSON(env, "audit", []);
      audit.unshift({ at: entry.at, by: entry.by, map, place, lang, display });
      await env.ADMIN.put("audit", JSON.stringify(audit.slice(0, 300)));
      return json({ ok: true, place, lang, entry });
    }

    return json({ error: "não encontrado" }, 404);
  },
};
