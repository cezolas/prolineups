// Pronades — public site Worker. Serves the static site (ASSETS) and only handles:
//   /auth/google            -> redirect to Google sign-in (OpenID Connect, code flow)
//   /auth/google/callback   -> exchange the code, create/update the user, set a signed session cookie
//   /auth/logout            -> clear the session
//   /api/me                 -> GET: who is signed in (401 if nobody) · DELETE: delete the account and its data (LGPD)
//   /api/data/<favs|plan>   -> GET/PUT: the user's saved favourites / training-plan progress (JSON, max 100 KB)
//   /auth/faceit            -> FACEIT sign-in (OAuth2 + PKCE); links to the signed-in account or creates a FACEIT one
//   /auth/faceit/callback   -> exchange the code, read the FACEIT profile, set the session
//   /api/faceit             -> GET: the user's FACEIT profile, lifetime + per-map stats and last matches (Data API, cached 10 min)
//   /api/react?k=<key>      -> GET: likes of one grenade/tactic, whether this visitor liked it, whether the admin removed it
//   /api/like               -> POST {k}: toggle this visitor's like (signed-in user, or an anonymous hash of the IP)
//   /api/report             -> POST {k, url, reason, note, lang}: "this is broken" report (max 5 per visitor per day)
// Premium Area: compare-my-demo, training plan, tactics, Meta Grenades (tactics hub, team plays, executes and their replay data) are served
// only to Premium users (KV "premium:<sub>", set in the online Admin); others go to /<lang>/premium/?from=<page>.
// deploy.py routes exactly these paths through this Worker (assets.run_worker_first).
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

// linking an account that already belongs to another Pronades account: back to the page with ?link_error=<provider>
function linkError(next, provider) {
  const to = safeNext(next);
  return new Response(null, { status: 302, headers: { location: `${to}${to.includes("?") ? "&" : "?"}link_error=${provider}`,
                                                      "cache-control": "no-store" } });
}

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
  // Which account does this Google login belong to? KV "google:<sub>" -> account (set when Google was linked to a
  // FACEIT-first account); older accounts are keyed by the Google sub itself.
  const gsub = claims.sub, now = new Date().toISOString();
  const owner = (await env.USERS.get(`google:${gsub}`)) || ((await env.USERS.get(`user:${gsub}`)) ? gsub : null);
  const current = await readSession(env, req);
  if (current && owner && owner !== current) return linkError(next, "google");  // that Google account is someone else's
  const sub = current || owner || gsub, linking = !!current && !owner;
  const key = `user:${sub}`;
  const old = await env.USERS.get(key, "json");
  const google = { sub: gsub, email: claims.email || null, name: claims.name || null, picture: claims.picture || null };
  await env.USERS.put(key, JSON.stringify({
    ...(old || {}),  // keep what other sign-ins stored (FACEIT link…)
    sub, google, email: claims.email || old?.email || null, name: old?.name || claims.name || null,
    picture: claims.picture || old?.picture || null, created: old?.created || now, last_login: now,
  }));
  if (sub !== gsub) await env.USERS.put(`google:${gsub}`, sub);
  await logEvent(env, req, sub, linking ? "google_link" : "login", null, "google");
  const h = new Headers({ location: safeNext(next) });
  h.append("set-cookie", setCookie(COOKIE, await makeSession(env, sub), SESSION_DAYS * DAY));
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
  const signedIn = !!sub;
  const now = new Date().toISOString();
  const owner = (await env.USERS.get(`faceit:${fid}`)) || ((await env.USERS.get(`user:faceit:${fid}`)) ? `faceit:${fid}` : null);
  if (signedIn && owner && owner !== sub) return linkError(next, "faceit");  // that FACEIT account is someone else's
  if (!sub) sub = owner || `faceit:${fid}`;
  const key = `user:${sub}`;
  const old = (await env.USERS.get(key, "json")) || { sub, created: now, name: me.nickname || null, email: me.email || null, picture: me.picture || null };
  old.faceit = faceit; old.last_login = now;
  await env.USERS.put(key, JSON.stringify(old));
  await env.USERS.put(`faceit:${fid}`, sub);  // FACEIT id -> account, so a later FACEIT sign-in finds it
  await logEvent(env, req, sub, signedIn ? "faceit_link" : "login", null, "faceit");
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

// ---------------------------------------------------------------- activity log (D1, signed-in users only)
const LOG_KINDS = new Set(["page", "video", "copy", "download", "demo", "login", "faceit_link", "google_link", "matchmode", "share", "fav"]);
function device(req) {
  const ua = req.headers.get("user-agent") || "";
  return /iPad|Tablet/i.test(ua) ? "tablet" : /Mobi|Android|iPhone/i.test(ua) ? "mobile" : "desktop";
}
async function logEvent(env, req, sub, kind, path, detail, lang) {
  if (!env.DB || !sub || !LOG_KINDS.has(kind)) return;
  try {
    await env.DB.prepare("INSERT INTO events (ts, sub, kind, path, detail, lang, device, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), sub, kind, String(path || "").slice(0, 300) || null, String(detail || "").slice(0, 300) || null,
            String(lang || "").slice(0, 5) || null, device(req), (req.cf && req.cf.country) || null).run();
  } catch (e) { /* the log must never break the site */ }
}

// ---------------------------------------------------------------- likes + reports (D1, open to everyone)
// key = "<g|e|p>:<map>/<slug>"  (g = grenade category, e = execute, p = team play)
const REACT_KEY = /^[gep]:[a-z0-9_]{2,40}\/[a-z0-9-]{1,120}$/;
const REPORT_REASONS = new Set(["video", "wrong", "outdated", "other"]);
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS likes (k TEXT NOT NULL, who TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (k, who))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, url TEXT, reason TEXT, note TEXT, who TEXT, lang TEXT, ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open')"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS removed (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, by TEXT, title TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS reports_status ON reports (status, ts)"),
  ]);
  schemaReady = true;
}
async function visitor(env, req, sub) {
  if (sub) return `u:${sub}`;
  const ip = req.headers.get("cf-connecting-ip") || "?";
  return `a:${(await hmac(env.SESSION_SECRET || "pronades", `ip:${ip}`)).slice(0, 22)}`;  // never store the raw IP
}
async function readBody(req, max = 2000) {
  const raw = await req.text();
  if (raw.length > max) return null;
  try { const b = JSON.parse(raw); return b && typeof b === "object" ? b : null; } catch { return null; }
}
async function reactApi(req, env, url, sub) {
  if (!env.DB) return json({ error: "not configured" }, 503);
  await ensureSchema(env);
  const who = await visitor(env, req, sub);
  if (url.pathname === "/api/react" && req.method === "GET") {
    const k = url.searchParams.get("k") || "";
    if (!REACT_KEY.test(k)) return json({ error: "bad key" }, 400);
    const [n, mine, rm] = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE k = ?").bind(k),
      env.DB.prepare("SELECT 1 AS x FROM likes WHERE k = ? AND who = ?").bind(k, who),
      env.DB.prepare("SELECT 1 AS x FROM removed WHERE k = ?").bind(k),
    ]);
    return json({ likes: n.results[0].n, liked: mine.results.length > 0, removed: rm.results.length > 0 });
  }
  if (url.pathname === "/api/like" && req.method === "POST") {
    const b = await readBody(req);
    if (!b || !REACT_KEY.test(b.k || "")) return json({ error: "bad key" }, 400);
    const had = await env.DB.prepare("SELECT 1 FROM likes WHERE k = ? AND who = ?").bind(b.k, who).first();
    if (had) await env.DB.prepare("DELETE FROM likes WHERE k = ? AND who = ?").bind(b.k, who).run();
    else await env.DB.prepare("INSERT OR IGNORE INTO likes (k, who, ts) VALUES (?, ?, ?)").bind(b.k, who, Date.now()).run();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE k = ?").bind(b.k).first();
    return json({ likes: n.n, liked: !had });
  }
  if (url.pathname === "/api/report" && req.method === "POST") {
    const b = await readBody(req);
    if (!b || !REACT_KEY.test(b.k || "") || !REPORT_REASONS.has(b.reason)) return json({ error: "invalid" }, 400);
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE who = ? AND ts > ?").bind(who, Date.now() - DAY * 1000).first();
    if (recent.n >= 5) return json({ error: "too many" }, 429);
    const path = typeof b.url === "string" && /^\/[a-z]{2}\/[^\s]{1,250}$/.test(b.url) ? b.url : null;
    await env.DB.prepare("INSERT INTO reports (k, url, reason, note, who, lang, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(b.k, path, b.reason, String(b.note || "").slice(0, 500) || null, who, String(b.lang || "").slice(0, 5) || null, Date.now()).run();
    return json({ ok: true });
  }
  return null;
}

async function api(req, env, url) {
  const sub = await readSession(env, req);
  if (["/api/react", "/api/like", "/api/report"].includes(url.pathname)) {
    const r = await reactApi(req, env, url, sub);
    if (r) return r;
  }
  if (url.pathname === "/api/me") {
    if (!sub) return json({ error: "not signed in", configured: configured(env) || faceitReady(env), google: configured(env), faceit_login: faceitReady(env) }, 401);
    if (req.method === "DELETE") {  // LGPD: delete the account and everything stored for it
      const u = await env.USERS.get(`user:${sub}`, "json");
      const extra = u && u.faceit ? [env.USERS.delete(`faceit:${u.faceit.id}`), env.USERS.delete(`fcache:${u.faceit.id}`)] : [];
      if (u && u.google && u.google.sub) extra.push(env.USERS.delete(`google:${u.google.sub}`));
      if (env.DB) await env.DB.prepare("DELETE FROM events WHERE sub = ?").bind(sub).run().catch(() => {});
      await Promise.all([env.USERS.delete(`user:${sub}`), env.USERS.delete(`premium:${sub}`), ...extra, ...[...DATA_KEYS].map((k) => env.USERS.delete(`data:${sub}:${k}`))]);
      return json({ deleted: true }, 200, { "set-cookie": setCookie(COOKIE, "", 0) });
    }
    const u = await env.USERS.get(`user:${sub}`, "json");
    if (!u) return json({ error: "not signed in" }, 401, { "set-cookie": setCookie(COOKIE, "", 0) });
    return json({ user: { name: u.name, email: u.email, picture: u.picture, created: u.created,
                          faceit: u.faceit ? { nickname: u.faceit.nickname, picture: u.faceit.picture } : null,
                          google: u.google ? { email: u.google.email } : (String(sub).startsWith("faceit:") ? null : { email: u.email }),
                          premium: await isPremium(env, sub), admin: await isAdmin(env, u) },
                  faceit_login: faceitReady(env) });
  }
  if (url.pathname === "/api/log" && req.method === "POST") {
    if (!sub) return new Response(null, { status: 204 });
    const raw = await req.text();
    if (raw.length > 4000) return json({ error: "too large" }, 413);
    let items = [];
    try { const b = JSON.parse(raw); items = Array.isArray(b) ? b : [b]; } catch { return json({ error: "invalid json" }, 400); }
    for (const it of items.slice(0, 10)) await logEvent(env, req, sub, it && it.k, it && it.p, it && it.d, it && it.l);
    return new Response(null, { status: 204 });
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

// ---------------------------------------------------------------- Premium Area
const PREMIUM_PAGE = /^\/(pt|en)\/(?:(?:comparar-minha-demo|compare-my-demo|plano-de-treino|training-plan|taticas|tactics|meta-grenades)|[a-z0-9]+\/(?:jogadas|plays|execucoes|executes))(?:\/|$)/;
const PREMIUM_DATA = /^\/dados\/jogadas\//;
// admins: the online Admin mirrors SHA-256 hashes of its ADMIN_EMAILS into KV "cfg:admins" (no e-mails stored here)
async function isAdmin(env, u) {
  const emails = [u && u.email, u && u.google && u.google.email].filter(Boolean).map((e) => String(e).trim().toLowerCase());
  if (!emails.length || !env.USERS) return false;
  const list = (await env.USERS.get("cfg:admins", "json")) || [];
  if (!list.length) return false;
  for (const e of emails) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e));
    if (list.includes([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""))) return true;
  }
  return false;
}
const isPremium = async (env, sub) => !!(sub && env.USERS && (await env.USERS.get(`premium:${sub}`)));
async function premiumGate(req, env, url) {
  const page = url.pathname.match(PREMIUM_PAGE);
  if (!page && !PREMIUM_DATA.test(url.pathname)) return null;
  if (await isPremium(env, await readSession(env, req))) {
    const r = await env.ASSETS.fetch(req);
    const out = new Response(r.body, r);
    out.headers.set("cache-control", "private, no-store");  // never cached for other visitors
    return out;
  }
  if (!page) return json({ error: "premium" }, 403);
  return new Response(null, { status: 302, headers: {
    location: `/${page[1]}/premium/?from=${encodeURIComponent(url.pathname)}`, "cache-control": "no-store" } });
}

// Errors: every route is awaited inside the try, so a failure becomes a handled 500 (not Cloudflare's "Error 1101").
// The last 30 are kept in KV "log:errors" (time, method, path without query, message) to find the cause; no user data.
async function recordError(env, req, url, e) {
  console.error(url.pathname, e && e.stack || e);
  if (!env.USERS) return;
  try {
    const list = (await env.USERS.get("log:errors", "json")) || [];
    list.unshift({ at: new Date().toISOString(), method: req.method, path: url.pathname.slice(0, 200),
                   error: String((e && e.message) || e).slice(0, 300), stack: String((e && e.stack) || "").split("\n").slice(0, 4).join(" | ").slice(0, 600) });
    await env.USERS.put("log:errors", JSON.stringify(list.slice(0, 30)), { expirationTtl: 30 * DAY });
  } catch { /* logging must never fail the response */ }
}
function errorPage(url) {
  if (url.pathname.startsWith("/api/")) return json({ error: "server error" }, 500);
  const lang = /^\/en\//.test(url.pathname) ? "en" : "pt";
  const msg = lang === "en" ? "Something went wrong on our side. Please try again in a moment." : "Algo deu errado do nosso lado. Tente de novo em instantes.";
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pronades</title>
<body style="font-family:system-ui,sans-serif;background:#0f1218;color:#e8eaee;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center;padding:24px"><h1 style="margin:0 0 8px">Pronades</h1><p>${msg}</p><p><a style="color:#f5b83d" href="/${lang}/">${lang === "en" ? "Back to the home page" : "Voltar para o início"}</a></p></div>`,
    { status: 500, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/auth/google") return await authStart(req, env, url);
      if (url.pathname === "/auth/google/callback") return await authCallback(req, env, url);
      if (url.pathname === "/auth/faceit") return await faceitStart(req, env, url);
      if (url.pathname === "/auth/faceit/callback") return await faceitCallback(req, env, url);
      if (url.pathname === "/auth/logout") {
        const lang = (url.searchParams.get("lang") || "pt").slice(0, 2);
        return new Response(null, { status: 302, headers: { location: `/${lang}/`, "set-cookie": setCookie(COOKIE, "", 0) } });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!env.USERS) return json({ error: "not configured" }, 503);
        return await api(req, env, url);
      }
      const gated = await premiumGate(req, env, url);
      if (gated) return gated;
      return await env.ASSETS.fetch(req);
    } catch (e) {
      await recordError(env, req, url, e);
      return errorPage(url);
    }
  },
};
