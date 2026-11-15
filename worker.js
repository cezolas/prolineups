// Pronades — public site Worker. Serves the static site (ASSETS) and only handles:
//   /auth/google            -> redirect to Google sign-in (OpenID Connect, code flow)
//   /auth/google/callback   -> exchange the code, create/update the user, set a signed session cookie
//   /auth/logout            -> clear the session
//   /api/me                 -> GET: who is signed in (401 if nobody) · DELETE: delete the account and its data (LGPD)
//   /api/data/<favs|plan>   -> GET/PUT: the user's saved favourites / training-plan progress (JSON, max 100 KB)
// Settings: vars GOOGLE_CLIENT_ID; secrets GOOGLE_CLIENT_SECRET, SESSION_SECRET; KV binding USERS.
// Stored per user (KV): Google id (sub), name, e-mail, photo URL, created/last login, favourites, plan progress.

const COOKIE = "pn_s", STATE = "pn_st", DAY = 86400;
const SESSION_DAYS = 30, DATA_KEYS = new Set(["favs", "plan"]), MAX_DATA = 100 * 1024;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env, sub) {
  const payload = b64urlText(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * DAY }));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}
async function readSession(env, req) {
  const raw = cookies(req)[COOKIE];
  if (!raw || !env.SESSION_SECRET) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !safeEqual(sig, await hmac(env.SESSION_SECRET, payload))) return null;
  try {
    const s = JSON.parse(fromB64url(payload));
    return s.exp > Date.now() / 1000 ? s.sub : null;
  } catch { return null; }
}
const safeNext = (n) => (typeof n === "string" && /^\/[a-z]{2}\/[^\s]*$/.test(n) && !n.startsWith("//") ? n : "/");
const configured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET && env.USERS);

async function authStart(req, env, url) {
  if (!configured(env)) return new Response("Login ainda não configurado.", { status: 503 });
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const next = safeNext(url.searchParams.get("next"));
  const go = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  go.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/auth/google/callback`, response_type: "code",
    scope: "openid email profile", state, prompt: "select_account",
  }).toString();
  return new Response(null, { status: 302, headers: { location: go.toString(), "set-cookie": setCookie(STATE, `${state}|${next}`, 600) } });
}

async function authCallback(req, env, url) {
  if (!configured(env)) return new Response("Login ainda não configurado.", { status: 503 });
  const [state, next] = (cookies(req)[STATE] || "").split("|");
  const code = url.searchParams.get("code");
  if (!code || !state || !safeEqual(state, url.searchParams.get("state") || "")) return new Response("Login inválido, tente de novo.", { status: 400 });
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
                                redirect_uri: `${url.origin}/auth/google/callback`, grant_type: "authorization_code" }),
  }).then((r) => r.json());
  if (!tok.id_token) return new Response("O Google não confirmou o login.", { status: 400 });
  // the id_token came straight from Google's token endpoint over TLS (code flow + client secret): its claims are trusted
  const claims = JSON.parse(fromB64url(tok.id_token.split(".")[1]));
  const okIss = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!okIss || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub || claims.exp < Date.now() / 1000)
    return new Response("Login inválido.", { status: 400 });
  const key = `user:${claims.sub}`, now = new Date().toISOString();
  const old = await env.USERS.get(key, "json");
  await env.USERS.put(key, JSON.stringify({
    sub: claims.sub, email: claims.email || null, name: claims.name || null, picture: claims.picture || null,
    created: old?.created || now, last_login: now,
  }));
  const h = new Headers({ location: safeNext(next) });
  h.append("set-cookie", setCookie(COOKIE, await makeSession(env, claims.sub), SESSION_DAYS * DAY));
  h.append("set-cookie", setCookie(STATE, "", 0));
  return new Response(null, { status: 302, headers: h });
}

async function api(req, env, url) {
  const sub = await readSession(env, req);
  if (url.pathname === "/api/me") {
    if (!sub) return json({ error: "not signed in", configured: configured(env) }, 401);
    if (req.method === "DELETE") {  // LGPD: delete the account and everything stored for it
      await Promise.all([env.USERS.delete(`user:${sub}`), ...[...DATA_KEYS].map((k) => env.USERS.delete(`data:${sub}:${k}`))]);
      return json({ deleted: true }, 200, { "set-cookie": setCookie(COOKIE, "", 0) });
    }
    const u = await env.USERS.get(`user:${sub}`, "json");
    if (!u) return json({ error: "not signed in" }, 401, { "set-cookie": setCookie(COOKIE, "", 0) });
    return json({ user: { name: u.name, email: u.email, picture: u.picture, created: u.created } });
  }
  const m = url.pathname.match(/^\/api\/data\/([a-z]+)$/);
  if (m && DATA_KEYS.has(m[1])) {
    if (!sub) return json({ error: "not signed in" }, 401);
    const key = `data:${sub}:${m[1]}`;
    if (req.method === "GET") return json({ data: (await env.USERS.get(key, "json")) ?? null });
    if (req.method === "PUT") {
      const body = await req.text();
      if (body.length > MAX_DATA) return json({ error: "too large" }, 413);
      try { JSON.parse(body); } catch { return json({ error: "invalid json" }, 400); }
      await env.USERS.put(key, body);
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/auth/google") return authStart(req, env, url);
      if (url.pathname === "/auth/google/callback") return authCallback(req, env, url);
      if (url.pathname === "/auth/logout") {
        const lang = (url.searchParams.get("lang") || "pt").slice(0, 2);
        return new Response(null, { status: 302, headers: { location: `/${lang}/`, "set-cookie": setCookie(COOKIE, "", 0) } });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!env.USERS) return json({ error: "not configured" }, 503);
        return api(req, env, url);
      }
    } catch (e) {
      return json({ error: "server error" }, 500);
    }
    return env.ASSETS.fetch(req);
  },
};
