// Pronades — public site Worker. Serves the static site (ASSETS) and only handles:
//   /auth/google            -> redirect to Google sign-in (OpenID Connect, code flow)
//   /auth/google/callback   -> exchange the code, create/update the user, set a signed session cookie
//   /auth/logout            -> clear the session
//   /api/me                 -> GET: who is signed in (401 if nobody) · DELETE: delete the account and its data (LGPD)
//   /api/data/<favs|plan>   -> GET/PUT: the user's saved favourites / training-plan progress (JSON, max 100 KB)
//   /auth/faceit            -> FACEIT sign-in (OAuth2 + PKCE); links to the signed-in account or creates a FACEIT one
//   /auth/faceit/callback   -> exchange the code, read the FACEIT profile, set the session
//   /api/faceit             -> GET: the user's FACEIT profile, lifetime + per-map stats and last matches (Data API, cached 10 min)
// Settings: vars GOOGLE_CLIENT_ID, FACEIT_CLIENT_ID; secrets GOOGLE_CLIENT_SECRET, SESSION_SECRET, FACEIT_CLIENT_SECRET,
// FACEIT_API_KEY; KV binding USERS.
// Stored per user (KV): Google id (sub), name, e-mail, photo URL, created/last login, favourites, plan progress.

const COOKIE = "pn_s", STATE = "pn_st", FSTATE = "pn_fst", DAY = 86400;
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


// ---------------------------------------------------------------- FACEIT
const faceitReady = (env) => !!(env.FACEIT_CLIENT_ID && env.FACEIT_CLIENT_SECRET && env.SESSION_SECRET && env.USERS);
async function sha256b64url(text) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
async function faceitStart(req, env, url) {
  if (!faceitReady(env)) return new Response("Login FACEIT ainda não configurado.", { status: 503 });
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const next = safeNext(url.searchParams.get("next"));
  const go = new URL("https://accounts.faceit.com");
  go.search = new URLSearchParams({
    response_type: "code", client_id: env.FACEIT_CLIENT_ID, redirect_uri: `${url.origin}/auth/faceit/callback`,
    scope: "openid profile email", state, code_challenge: await sha256b64url(verifier), code_challenge_method: "S256",
    redirect_popup: "true",
  }).toString();
  return new Response(null, { status: 302, headers: { location: go.toString(), "set-cookie": setCookie(FSTATE, `${state}|${verifier}|${next}`, 600) } });
}
async function faceitCallback(req, env, url) {
  if (!faceitReady(env)) return new Response("Login FACEIT ainda não configurado.", { status: 503 });
  const [state, verifier, next] = (cookies(req)[FSTATE] || "").split("|");
  const code = url.searchParams.get("code");
  if (!code || !state || !safeEqual(state, url.searchParams.get("state") || "")) return new Response("Login inválido, tente de novo.", { status: 400 });
  const tok = await fetch("https://api.faceit.com/auth/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa(`${env.FACEIT_CLIENT_ID}:${env.FACEIT_CLIENT_SECRET}`) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: `${url.origin}/auth/faceit/callback` }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!tok.access_token) return new Response("A FACEIT não confirmou o login.", { status: 400 });
  const me = await fetch("https://api.faceit.com/auth/v1/resources/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } })
    .then((r) => r.json()).catch(() => ({}));
  const fid = me.guid || me.sub;
  if (!fid) return new Response("Não consegui ler seu perfil FACEIT.", { status: 400 });
  const faceit = { id: fid, nickname: me.nickname || null, picture: me.picture || null, linked: new Date().toISOString() };
  // already signed in (e.g. Google)? link FACEIT to that account; otherwise use/create the FACEIT account
  let sub = await readSession(env, req);
  const now = new Date().toISOString();
  if (!sub) {
    sub = (await env.USERS.get(`faceit:${fid}`)) || `faceit:${fid}`;
  }
  const key = `user:${sub}`;
  const old = (await env.USERS.get(key, "json")) || { sub, created: now, name: me.nickname || null, email: me.email || null, picture: me.picture || null };
  old.faceit = faceit; old.last_login = now;
  await env.USERS.put(key, JSON.stringify(old));
  await env.USERS.put(`faceit:${fid}`, sub);  // FACEIT id -> account, so a later FACEIT sign-in finds it
  const h = new Headers({ location: safeNext(next) });
  h.append("set-cookie", setCookie(COOKIE, await makeSession(env, sub), SESSION_DAYS * DAY));
  h.append("set-cookie", setCookie(FSTATE, "", 0));
  return new Response(null, { status: 302, headers: h });
}
async function faceitData(env, fid) {
  const cacheKey = `fcache:${fid}`;
  const cached = await env.USERS.get(cacheKey, "json");
  if (cached && cached.at > Date.now() - 10 * 60 * 1000) return cached.data;
  const api = (p) => fetch(`https://open.faceit.com/data/v4${p}`, { headers: { authorization: `Bearer ${env.FACEIT_API_KEY}` } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [player, stats, hist] = await Promise.all([api(`/players/${fid}`), api(`/players/${fid}/stats/cs2`), api(`/players/${fid}/history?game=cs2&limit=10`)]);
  const items = (hist && hist.items) || [];
  const matches = await Promise.all(items.map(async (m) => {
    const st = await api(`/matches/${m.match_id}/stats`);
    const round = st && st.rounds && st.rounds[0];
    if (!round) return { id: m.match_id, at: m.finished_at || m.started_at };
    let mine = null, myTeam = null;
    for (const t of round.teams || []) for (const p of t.players || []) if (p.player_id === fid) { mine = p.player_stats; myTeam = t; }
    const rs = round.round_stats || {};
    return { id: m.match_id, at: m.finished_at || m.started_at, map: rs.Map, score: rs.Score, rounds: +rs.Rounds || null,
             won: myTeam ? (myTeam.team_stats || {})["Team Win"] === "1" : null,
             k: mine ? +mine.Kills : null, d: mine ? +mine.Deaths : null, a: mine ? +mine.Assists : null,
             kd: mine ? +mine["K/D Ratio"] : null, kr: mine ? +mine["K/R Ratio"] : null, hs: mine ? +mine["Headshots %"] : null,
             adr: mine ? +(mine.ADR || mine["ADR"] || 0) || null : null, mvps: mine ? +mine.MVPs : null };
  }));
  const life = (stats && stats.lifetime) || {};
  const data = {
    nickname: player && player.nickname, avatar: player && player.avatar, country: player && player.country,
    level: player && player.games && player.games.cs2 && player.games.cs2.skill_level,
    elo: player && player.games && player.games.cs2 && player.games.cs2.faceit_elo,
    lifetime: { matches: +life.Matches || null, winrate: +life["Win Rate %"] || null, kd: +life["Average K/D Ratio"] || null,
                hs: +life["Average Headshots %"] || null, streak: +life["Longest Win Streak"] || null, recent: life["Recent Results"] || [] },
    maps: ((stats && stats.segments) || []).filter((s) => s.type === "Map" && s.mode === "5v5").map((s) => ({
      map: s.label, matches: +s.stats.Matches || 0, winrate: +s.stats["Win Rate %"] || null, kd: +s.stats["Average K/D Ratio"] || null,
      hs: +s.stats["Average Headshots %"] || null })).sort((a, b) => b.matches - a.matches),
    matches,
  };
  await env.USERS.put(cacheKey, JSON.stringify({ at: Date.now(), data }), { expirationTtl: 3600 });
  return data;
}

async function api(req, env, url) {
  const sub = await readSession(env, req);
  if (url.pathname === "/api/me") {
    if (!sub) return json({ error: "not signed in", configured: configured(env) || faceitReady(env), google: configured(env), faceit_login: faceitReady(env) }, 401);
    if (req.method === "DELETE") {  // LGPD: delete the account and everything stored for it
      const u = await env.USERS.get(`user:${sub}`, "json");
      const extra = u && u.faceit ? [env.USERS.delete(`faceit:${u.faceit.id}`), env.USERS.delete(`fcache:${u.faceit.id}`)] : [];
      await Promise.all([env.USERS.delete(`user:${sub}`), ...extra, ...[...DATA_KEYS].map((k) => env.USERS.delete(`data:${sub}:${k}`))]);
      return json({ deleted: true }, 200, { "set-cookie": setCookie(COOKIE, "", 0) });
    }
    const u = await env.USERS.get(`user:${sub}`, "json");
    if (!u) return json({ error: "not signed in" }, 401, { "set-cookie": setCookie(COOKIE, "", 0) });
    return json({ user: { name: u.name, email: u.email, picture: u.picture, created: u.created,
                          faceit: u.faceit ? { nickname: u.faceit.nickname, picture: u.faceit.picture } : null },
                  faceit_login: faceitReady(env) });
  }
  if (url.pathname === "/api/faceit") {
    if (!sub) return json({ error: "not signed in" }, 401);
    const u = await env.USERS.get(`user:${sub}`, "json");
    if (!u || !u.faceit) return json({ error: "faceit not linked", faceit_login: faceitReady(env) }, 404);
    if (!env.FACEIT_API_KEY) return json({ error: "not configured" }, 503);
    return json({ faceit: await faceitData(env, u.faceit.id) });
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
      if (url.pathname === "/auth/faceit") return faceitStart(req, env, url);
      if (url.pathname === "/auth/faceit/callback") return faceitCallback(req, env, url);
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
