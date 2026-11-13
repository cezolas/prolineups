// Lineups Pro — online Admin (Cloudflare Worker).
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
//   GET  /api/export            -> all overrides (used by pipeline/admin_sync.py on the studio PC)
// Everything else is served from ./public (the admin page, radars, place lists).

const MAP_RE = /^[a-z0-9_]{2,40}$/;
const PLACE_RE = /^[A-Za-z0-9_]{1,60}$/;
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

async function accessKeys(env) {
  if (Date.now() - certsCache.at < 3600_000 && certsCache.keys.length) return certsCache.keys;
  const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("não consegui ler as chaves do Cloudflare Access");
  certsCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return certsCache.keys;
}

// Returns the verified Access identity ({ email } for people, { common_name } for service tokens) or null.
async function verifyAccess(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64urlToJson(parts[0]); payload = b64urlToJson(parts[1]); } catch { return null; }
  if (header.alg !== "RS256") return null;
  let keys = await accessKeys(env);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { certsCache.at = 0; keys = await accessKeys(env); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
                                        new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  return payload;
}

function role(identity, env) {
  if (!identity) return null;
  const admins = String(env.ADMIN_EMAILS || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (identity.email && admins.includes(String(identity.email).toLowerCase())) return "admin";
  if (identity.common_name && env.SYNC_CLIENT_ID && identity.common_name === env.SYNC_CLIENT_ID) return "sync";
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
    let identity;
    try { identity = await verifyAccess(request, env); } catch (e) { return json({ error: String(e.message || e) }, 503); }
    const who = role(identity, env);
    if (!who) {
      return new Response("Acesso negado. Entre com um e-mail autorizado (Cloudflare Access).", {
        status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (!url.pathname.startsWith("/api/")) {
      if (who !== "admin") return new Response("Somente leitura.", { status: 403 });
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/export" && request.method === "GET") {
      const maps = {};
      const list = await env.ADMIN.list({ prefix: "places:" });
      for (const k of list.keys) maps[k.name.slice(7)] = await readJSON(env, k.name, {});
      return json({ maps, exported_at: new Date().toISOString() });
    }
    if (who !== "admin") return json({ error: "token de sincronização só pode exportar" }, 403);

    if (url.pathname === "/api/me") return json({ email: identity.email });

    if (url.pathname === "/api/audit") return json({ items: await readJSON(env, "audit", []) });

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
