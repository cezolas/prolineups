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
