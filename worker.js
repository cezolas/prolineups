// Pronades — public site Worker. Serves the static site (ASSETS) and only handles:
//   /auth/google            -> redirect to Google sign-in (OpenID Connect, code flow)
//   /auth/google/callback   -> exchange the code, create/update the user, set a signed session cookie
//   /auth/logout            -> clear the session
//   /api/me                 -> GET: who is signed in (401 if nobody) · DELETE: delete the account and its data (LGPD)
//   /api/data/<favs|plan>   -> GET/PUT: the user's saved favourites / training-plan progress (JSON, max 100 KB)
//   /auth/faceit            -> FACEIT sign-in (OAuth2 + PKCE); links to the signed-in account or creates a FACEIT one
//   /auth/steam             -> Steam sign-in (OpenID 2.0, verified with Steam's check_authentication); links or creates
//   /auth/steam/callback    -> optional secret STEAM_API_KEY: the Steam name and avatar (GetPlayerSummaries)
//   /api/steam              -> GET: the user's CS2 lifetime stats from Steam (GetUserStatsForGame, cached 30 min)
//   /auth/faceit/callback   -> exchange the code, read the FACEIT profile, set the session
//   /api/faceit             -> GET: the user's FACEIT profile, lifetime + per-map stats and last matches (Data API, cached 10 min)
//   /api/react?k=<key>      -> GET: likes of one grenade/tactic, whether this visitor liked it, whether the admin removed it
//   /api/like               -> POST {k}: toggle this visitor's like (signed-in user, or an anonymous hash of the IP)
//   /api/report             -> POST {k, url, reason, note, lang}: "this is broken" report (max 5 per visitor per day)
//   /api/gw                 -> GET: giveaways + this user's entry and tickets · POST {id, ig, yt, acts}: join / update the entry
//   /v/<net><code>[e]       -> short link of a social post: 302 to the grenade page with utm tags (codes in /dados/social.json)
// Premium Area: compare-my-demo, training plan, tactics, Meta Grenades (tactics hub, team plays, executes and their replay data) are served
// only to Premium users (KV "premium:<sub>", set in the online Admin); others go to /<lang>/premium/?from=<page>.
// deploy.py routes exactly these paths through this Worker (assets.run_worker_first).
// Settings: vars GOOGLE_CLIENT_ID, FACEIT_CLIENT_ID; secrets GOOGLE_CLIENT_SECRET, SESSION_SECRET, FACEIT_CLIENT_SECRET,
// FACEIT_API_KEY; KV binding USERS.
// Stored per user (KV): Google id (sub), name, e-mail, photo URL, created/last login, favourites, plan progress.

const COOKIE = "pn_s", STATE = "pn_st", FSTATE = "pn_fst", SSTATE = "pn_sst", DAY = 86400;
const SESSION_DAYS = 30, DATA_KEYS = new Set(["favs", "plan", "tactics"]), MAX_DATA = 100 * 1024;

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

// KV write that may fail without breaking a sign-in: when "optional" (an existing account, only last_login changes),
// a failure (e.g. the free plan's daily write limit) is logged and ignored; otherwise it throws as usual
async function softPut(env, key, value, optional) {
  try { await env.USERS.put(key, value); }
  catch (e) { if (!optional) throw e; console.warn("KV write skipped:", key.split(":")[0], e && e.message); }
}

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
  await softPut(env, key, JSON.stringify({
    ...(old || {}),  // keep what other sign-ins stored (FACEIT link…)
    sub, google, email: claims.email || old?.email || null, name: old?.name || claims.name || null,
    picture: claims.picture || old?.picture || null, created: old?.created || now, last_login: now,
  }), !!old);
  if (sub !== gsub && (await env.USERS.get(`google:${gsub}`)) !== sub) await env.USERS.put(`google:${gsub}`, sub);
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
  const stored = await env.USERS.get(key, "json");
  const old = stored || { sub, created: now, name: me.nickname || null, email: me.email || null, picture: me.picture || null };
  const sameLink = !!(old.faceit && old.faceit.id === fid);
  old.faceit = { ...faceit, linked: sameLink ? old.faceit.linked : faceit.linked }; old.last_login = now;
  await softPut(env, key, JSON.stringify(old), !!stored && sameLink);
  if (owner !== sub) await env.USERS.put(`faceit:${fid}`, sub);  // FACEIT id -> account, so a later FACEIT sign-in finds it
  await logEvent(env, req, sub, signedIn ? "faceit_link" : "login", null, "faceit");
  const h = new Headers({ location: safeNext(next) });
  h.append("set-cookie", setCookie(COOKIE, await makeSession(env, sub), SESSION_DAYS * DAY));
  h.append("set-cookie", setCookie(FSTATE, "", 0));
  return new Response(null, { status: 302, headers: h });
}
// ---------------------------------------------------------------- "Minha Steam": CS2 stats of the linked Steam account
// Steam keeps lifetime totals for the whole account (every mode together) and a summary of the last match. They only
// come back when the profile's "Game details" are public; otherwise Steam answers 403 and the page explains how to open them.
async function steamData(env, sid) {
  const cacheKey = `scache:${sid}`;
  const cached = await env.USERS.get(cacheKey, "json");
  if (cached && cached.at > Date.now() - 30 * 60 * 1000) return cached.data;
  const r = await fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${env.STEAM_API_KEY}&steamid=${sid}`).catch(() => null);
  if (!r) return { error: "unavailable" };
  if (r.status === 403 || r.status === 400 || r.status === 401) return { error: "private" };
  if (!r.ok) return { error: "unavailable" };
  const j = await r.json().catch(() => null);
  const st = {};
  for (const x of ((j && j.playerstats && j.playerstats.stats) || [])) st[x.name] = x.value;
  if (!st.total_kills) return { error: "private" };
  const n = (k) => +st[k] || 0;
  const maps = Object.keys(st).filter((k) => k.startsWith("total_rounds_map_de_")).map((k) => {
    const m = k.replace("total_rounds_map_", "");
    return { map: m, rounds: n(k), wins: n(`total_wins_map_${m}`) };
  }).filter((m) => m.rounds >= 10).sort((a, b) => b.rounds - a.rounds);
  const data = {
    life: { kills: n("total_kills"), deaths: n("total_deaths"), rounds: n("total_rounds_played"), hs: n("total_kills_headshot"),
            awp: n("total_kills_awp") + n("total_kills_ssg08") + n("total_kills_g3sg1") + n("total_kills_scar20"),
            damage: n("total_damage_done"), mvps: n("total_mvps"), matches: n("total_matches_played"), wins: n("total_matches_won"),
            hours: Math.round(n("total_time_played") / 3600), plants: n("total_planted_bombs"), defuses: n("total_defused_bombs") },
    last: st.last_match_rounds ? { kills: n("last_match_kills"), deaths: n("last_match_deaths"), rounds: n("last_match_rounds"),
            damage: n("last_match_damage"), mvps: n("last_match_mvps"), won: n("last_match_wins") > n("last_match_rounds") / 2 } : null,
    maps,
  };
  try { await env.USERS.put(cacheKey, JSON.stringify({ at: Date.now(), data }), { expirationTtl: 3600 }); } catch (e) {}
  return data;
}

// ---------------------------------------------------------------- Steam (OpenID 2.0: no app registration, no secret)
const STEAM_OP = "https://steamcommunity.com/openid/login";
const steamReady = (env) => !!(env.SESSION_SECRET && env.USERS);
async function steamStart(req, env, url) {
  if (!steamReady(env)) return new Response("Login Steam ainda não configurado.", { status: 503 });
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const next = safeNext(url.searchParams.get("next"));
  const go = new URL(STEAM_OP);
  go.search = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0", "openid.mode": "checkid_setup",
    "openid.return_to": `${url.origin}/auth/steam/callback?st=${state}`, "openid.realm": url.origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  }).toString();
  return new Response(null, { status: 302, headers: { location: go.toString(), "set-cookie": setCookie(SSTATE, `${state}|${next}`, 600) } });
}
async function steamCallback(req, env, url) {
  if (!steamReady(env)) return new Response("Login Steam ainda não configurado.", { status: 503 });
  const [state, next] = (cookies(req)[SSTATE] || "").split("|");
  const p = url.searchParams;
  const bad = () => new Response("Login inválido, tente de novo.", { status: 400 });
  if (!state || !safeEqual(state, p.get("st") || "") || p.get("openid.mode") !== "id_res") return bad();
  if (p.get("openid.op_endpoint") !== STEAM_OP || !(p.get("openid.return_to") || "").startsWith(`${url.origin}/auth/steam/callback?`)) return bad();
  const m = (p.get("openid.claimed_id") || "").match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!m || p.get("openid.identity") !== p.get("openid.claimed_id")) return bad();
  // Steam itself confirms the signed answer (this is what makes the SteamID trustworthy)
  const body = new URLSearchParams();
  for (const [k, v] of p) if (k.startsWith("openid.")) body.set(k, v);
  body.set("openid.mode", "check_authentication");
  const check = await fetch(STEAM_OP, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })
    .then((r) => r.text()).catch(() => "");
  if (!/is_valid\s*:\s*true/.test(check)) return new Response("A Steam não confirmou o login.", { status: 400 });
  const sid = m[1];
  let prof = {};
  if (env.STEAM_API_KEY) {   // name + avatar (optional: without the key the account shows the SteamID)
    const j = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_API_KEY}&steamids=${sid}`)
      .then((r) => r.json()).catch(() => ({}));
    prof = ((j.response || {}).players || [])[0] || {};
  }
  const steam = { id: sid, name: prof.personaname || null, picture: prof.avatarfull || null, linked: new Date().toISOString() };
  let sub = await readSession(env, req);
  const signedIn = !!sub, now = new Date().toISOString();
  const owner = (await env.USERS.get(`steam:${sid}`)) || ((await env.USERS.get(`user:steam:${sid}`)) ? `steam:${sid}` : null);
  if (signedIn && owner && owner !== sub) return linkError(next, "steam");  // that Steam account is someone else's
  if (!sub) sub = owner || `steam:${sid}`;
  const key = `user:${sub}`;
  const stored = await env.USERS.get(key, "json");
  const old = stored || { sub, created: now, name: steam.name, email: null, picture: steam.picture };
  const sameLink = !!(old.steam && old.steam.id === sid);
  old.steam = { ...steam, name: steam.name || (old.steam && old.steam.name) || null, picture: steam.picture || (old.steam && old.steam.picture) || null,
                linked: sameLink ? old.steam.linked : steam.linked };
  if (!old.name && steam.name) old.name = steam.name;
  if (!old.picture && steam.picture) old.picture = steam.picture;
  old.last_login = now;
  await softPut(env, key, JSON.stringify(old), !!stored && sameLink);
  if (owner !== sub) await env.USERS.put(`steam:${sid}`, sub);  // SteamID -> account, so a later Steam sign-in finds it
  await logEvent(env, req, sub, signedIn ? "steam_link" : "login", null, "steam");
  const h = new Headers({ location: safeNext(next) });
  h.append("set-cookie", setCookie(COOKIE, await makeSession(env, sub), SESSION_DAYS * DAY));
  h.append("set-cookie", setCookie(SSTATE, "", 0));
  return new Response(null, { status: 302, headers: h });
}

async function faceitData(env, fid) {
  const cacheKey = `fcache:${fid}`;
  const cached = await env.USERS.get(cacheKey, "json");
  if (cached && cached.at > Date.now() - 10 * 60 * 1000) return cached.data;
  // FACEIT refuses bursts (429): retry a couple of times, and fetch the match stats a few at a time
  const api = async (p) => {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`https://open.faceit.com/data/v4${p}`, { headers: { authorization: `Bearer ${env.FACEIT_API_KEY}` } }).catch(() => null);
      if (r && r.ok) return r.json().catch(() => null);
      if (r && r.status !== 429 && r.status < 500) return null;  // 404 etc.: no point retrying
      await new Promise((ok) => setTimeout(ok, 400 * (i + 1)));
    }
    return null;
  };
  const [player, stats, hist] = await Promise.all([api(`/players/${fid}`), api(`/players/${fid}/stats/cs2`), api(`/players/${fid}/history?game=cs2&limit=10`)]);
  const items = (hist && hist.items) || [];
  const statsOf = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i += 3) {
    const part = await Promise.all(items.slice(i, i + 3).map((m) => api(`/matches/${m.match_id}/stats`)));
    part.forEach((x, j) => { statsOf[i + j] = x; });
  }
  let incomplete = false;
  const matches = items.map((m, idx) => {
    const st = statsOf[idx];
    const round = st && st.rounds && st.rounds[0];
    if (!round) {  // no stats (yet): still show win / loss and the score from the match history
      incomplete = true;
      const res = m.results || {}, teams = m.teams || {};
      const mySide = Object.keys(teams).find((f) => ((teams[f] || {}).players || []).some((p) => p.player_id === fid));
      const sc = res.score || {};
      return { id: m.match_id, at: m.finished_at || m.started_at, won: mySide && res.winner ? res.winner === mySide : null,
               score: mySide && sc[mySide] != null ? `${sc[mySide]} / ${Object.entries(sc).filter(([f]) => f !== mySide).map(([, v]) => v)[0]}` : null };
    }
    let mine = null, myTeam = null;
    for (const t of round.teams || []) for (const p of t.players || []) if (p.player_id === fid) { mine = p.player_stats; myTeam = t; }
    const rs = round.round_stats || {};
    return { id: m.match_id, at: m.finished_at || m.started_at, map: rs.Map, score: rs.Score, rounds: +rs.Rounds || null,
             won: myTeam ? (myTeam.team_stats || {})["Team Win"] === "1" : null,
             k: mine ? +mine.Kills : null, d: mine ? +mine.Deaths : null, a: mine ? +mine.Assists : null,
             kd: mine ? +mine["K/D Ratio"] : null, kr: mine ? +mine["K/R Ratio"] : null, hs: mine ? +mine["Headshots %"] : null,
             adr: mine ? +(mine.ADR || mine["ADR"] || 0) || null : null, mvps: mine ? +mine.MVPs : null,
             x: mine && mine["Entry Count"] != null ? {   // extended stats: the "Nota Pronades" on the page
               fk: +mine["First Kills"] || 0, ec: +mine["Entry Count"] || 0, ew: +mine["Entry Wins"] || 0,
               c1: +mine["1v1Wins"] || 0, c2: +mine["1v2Wins"] || 0, sk: +mine["Sniper Kills"] || 0,
               uc: +mine["Utility Count"] || 0, ef: +mine["Enemies Flashed"] || 0,
               mk: (+mine["Double Kills"] || 0) + (+mine["Triple Kills"] || 0) + (+mine["Quadro Kills"] || 0) + (+mine["Penta Kills"] || 0) } : null };
  });
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
  const at = incomplete ? Date.now() - 8 * 60 * 1000 : Date.now();
  try { await env.USERS.put(cacheKey, JSON.stringify({ at, data }), { expirationTtl: 3600 }); }
  catch (e) { console.warn("FACEIT cache not saved:", e && e.message); }  // the page still gets its data
  return data;
}

// ---------------------------------------------------------------- activity log (D1, signed-in users only)
const LOG_KINDS = new Set(["page", "video", "copy", "download", "demo", "login", "faceit_link", "google_link", "steam_link", "matchmode", "share", "fav"]);
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

// ---------------------------------------------------------------- giveaways (sorteios)
// Config: KV USERS "gw:cfg" = { events: [{ id, title, prize, desc, rules, image, start, end, draw_at, status, winner,
//   actions: [{ id, kind, label, url, tickets, max }] }] }, edited in the online Admin.
// kind: ig_comment / yt_comment are checked against KV "gw:<id>:comments" = { at, c: { <action id>: { <user>: n } } },
// written by pipeline/giveaway_sync.py (the Instagram/YouTube tokens stay on the studio PC). Every other kind
// (ig_follow, yt_sub, tt_follow, visit) is declared by the participant and checked on the winner before announcing.
// Entries: D1 "gw_entries", one per account per giveaway; an @ can belong to only one account per giveaway.
const GW_CHECKED = new Set(["ig_comment", "yt_comment"]);
const GW_KINDS = new Set(["ig_comment", "yt_comment", "ig_follow", "yt_sub", "tt_follow", "visit"]);
const GW_ID = /^[a-z0-9-]{2,40}$/;
const IG_USER = /^[a-z0-9._]{1,30}$/, YT_USER = /^[a-z0-9._-]{3,30}$/;
const cleanHandle = (s) => String(s || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?(instagram\.com|youtube\.com)\//, "").replace(/^@/, "").replace(/[/?#].*$/, "");
let GW_SCHEMA = false;
async function gwSchema(env) {
  if (GW_SCHEMA) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS gw_entries (gw TEXT NOT NULL, sub TEXT NOT NULL, ig TEXT, yt TEXT, acts TEXT NOT NULL DEFAULT '[]', ts INTEGER NOT NULL, upd INTEGER NOT NULL, PRIMARY KEY (gw, sub))"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS gw_ig ON gw_entries (gw, ig) WHERE ig IS NOT NULL"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS gw_yt ON gw_entries (gw, yt) WHERE yt IS NOT NULL"),
  ]);
  GW_SCHEMA = true;
}
const gwOpen = (e, now = Date.now()) => e.status !== "rascunho" && Date.parse(e.start) <= now && now < Date.parse(e.end);
// tickets of one entry: [{ id, n, ok, checked }] per action
function gwTickets(e, entry, comments) {
  const acts = new Set(entry ? JSON.parse(entry.acts || "[]") : []);
  return (e.actions || []).map((a) => {
    const w = Math.max(1, a.tickets | 0), max = Math.max(1, a.max | 0);
    if (GW_CHECKED.has(a.kind)) {
      const who = a.kind === "ig_comment" ? entry && entry.ig : entry && entry.yt;
      const n = who ? Math.min(max, ((comments.c || {})[a.id] || {})[who] | 0) : 0;
      return { id: a.id, n: n * w, ok: n > 0, checked: true, count: n };
    }
    return { id: a.id, n: acts.has(a.id) ? w : 0, ok: acts.has(a.id), checked: false };
  });
}
async function gwApi(req, env, url, sub) {
  if (!env.DB) return json({ error: "not configured" }, 503);
  const cfg = (await env.USERS.get("gw:cfg", "json")) || { events: [] };
  // drafts are shown only to admins (to test the entry before publishing); for them a draft takes entries until its end
  const u = sub ? await env.USERS.get(`user:${sub}`, "json") : null;
  const admin = !!u && (await isAdmin(env, u));
  const events = (cfg.events || []).filter((e) => e.status !== "rascunho" || admin);
  const isOpen = (e) => e.status === "rascunho" ? Date.now() < Date.parse(e.end) : gwOpen(e);
  if (req.method === "GET") {
    await gwSchema(env);
    const out = [];
    for (const e of events) {
      const comments = (await env.USERS.get(`gw:${e.id}:comments`, "json")) || {};
      const [cnt, mine] = await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM gw_entries WHERE gw = ?").bind(e.id),
        env.DB.prepare("SELECT * FROM gw_entries WHERE gw = ? AND sub = ?").bind(e.id, sub || ""),
      ]);
      const entry = mine.results[0] || null;
      out.push({
        id: e.id, title: e.title, prize: e.prize, desc: e.desc, rules: e.rules, image: e.image, start: e.start, end: e.end,
        draw_at: e.draw_at, open: isOpen(e), draft: e.status === "rascunho", winner: e.winner || null, participants: cnt.results[0].n, synced_at: comments.at || null,
        actions: (e.actions || []).map((a) => ({ id: a.id, kind: a.kind, label: a.label, url: a.url, tickets: Math.max(1, a.tickets | 0), max: Math.max(1, a.max | 0) })),
        me: entry ? { ig: entry.ig, yt: entry.yt, tickets: gwTickets(e, entry, comments) } : null,
      });
    }
    return json({ signed_in: !!sub, events: out });
  }
  if (req.method === "POST") {
    if (!sub) return json({ error: "entre na sua conta para participar" }, 401);
    const b = await readBody(req);
    const e = b && events.find((x) => x.id === b.id);
    if (!e) return json({ error: "sorteio não encontrado" }, 404);
    if (!isOpen(e)) return json({ error: "as inscrições deste sorteio estão fechadas" }, 409);
    const ig = cleanHandle(b.ig) || null, yt = cleanHandle(b.yt) || null;
    if (ig && !IG_USER.test(ig)) return json({ error: "@ do Instagram inválido" }, 400);
    if (yt && !YT_USER.test(yt)) return json({ error: "@ do YouTube inválido" }, 400);
    const valid = new Set((e.actions || []).filter((a) => !GW_CHECKED.has(a.kind)).map((a) => a.id));
    const acts = [...new Set(Array.isArray(b.acts) ? b.acts : [])].filter((x) => valid.has(x));
    await gwSchema(env);
    const now = Date.now();
    try {
      await env.DB.prepare(`INSERT INTO gw_entries (gw, sub, ig, yt, acts, ts, upd) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (gw, sub) DO UPDATE SET ig = excluded.ig, yt = excluded.yt, acts = excluded.acts, upd = excluded.upd`)
        .bind(e.id, sub, ig, yt, JSON.stringify(acts), now, now).run();
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) return json({ error: "esse @ já está inscrito por outra conta" }, 409);
      throw err;
    }
    return json({ ok: true });
  }
  return json({ error: "method" }, 405);
}

async function api(req, env, url) {
  const sub = await readSession(env, req);
  if (["/api/react", "/api/like", "/api/report"].includes(url.pathname)) {
    const r = await reactApi(req, env, url, sub);
    if (r) return r;
  }
  if (url.pathname === "/api/gw") return await gwApi(req, env, url, sub);
  if (url.pathname === "/api/me") {
    if (!sub) return json({ error: "not signed in", configured: configured(env) || faceitReady(env) || steamReady(env), google: configured(env),
                            faceit_login: faceitReady(env), steam_login: steamReady(env) }, 401);
    if (req.method === "DELETE") {  // LGPD: delete the account and everything stored for it
      const u = await env.USERS.get(`user:${sub}`, "json");
      const extra = u && u.faceit ? [env.USERS.delete(`faceit:${u.faceit.id}`), env.USERS.delete(`fcache:${u.faceit.id}`)] : [];
      if (u && u.google && u.google.sub) extra.push(env.USERS.delete(`google:${u.google.sub}`));
      if (u && u.steam && u.steam.id) extra.push(env.USERS.delete(`steam:${u.steam.id}`), env.USERS.delete(`scache:${u.steam.id}`));
      if (env.DB) await env.DB.prepare("DELETE FROM events WHERE sub = ?").bind(sub).run().catch(() => {});
      if (env.DB) await env.DB.prepare("DELETE FROM gw_entries WHERE sub = ?").bind(sub).run().catch(() => {});
      await Promise.all([env.USERS.delete(`user:${sub}`), env.USERS.delete(`premium:${sub}`), ...extra, ...[...DATA_KEYS].map((k) => env.USERS.delete(`data:${sub}:${k}`))]);
      return json({ deleted: true }, 200, { "set-cookie": setCookie(COOKIE, "", 0) });
    }
    const u = await env.USERS.get(`user:${sub}`, "json");
    if (!u) return json({ error: "not signed in" }, 401, { "set-cookie": setCookie(COOKIE, "", 0) });
    return json({ user: { name: u.name, email: u.email, picture: u.picture, created: u.created,
                          faceit: u.faceit ? { nickname: u.faceit.nickname, picture: u.faceit.picture } : null,
                          steam: u.steam ? { id: u.steam.id, name: u.steam.name, picture: u.steam.picture } : null,
                          google: u.google ? { email: u.google.email } : (/^(faceit|steam):/.test(String(sub)) ? null : { email: u.email }),
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
  if (url.pathname === "/api/steam") {
    if (!sub) return json({ error: "not signed in", steam_login: steamReady(env) }, 401);
    const u = await env.USERS.get(`user:${sub}`, "json");
    if (!u || !u.steam || !u.steam.id) return json({ error: "steam not linked", steam_login: steamReady(env) }, 404);
    if (!env.STEAM_API_KEY) return json({ error: "not configured" }, 503);
    const d = await steamData(env, u.steam.id);
    if (d.error) return json({ error: d.error, steam: { name: u.steam.name, picture: u.steam.picture } }, d.error === "private" ? 403 : 502);
    return json({ steam: { name: u.steam.name, picture: u.steam.picture, id: u.steam.id, ...d } });
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
      if ((await env.USERS.get(key)) === body) return json({ ok: true, unchanged: true });
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
// They are kept 30 days in D1 table "errors" (time, method, path without query, message) to find the cause; no user data.
async function recordError(env, req, url, e) {
  console.error(url.pathname, e && e.stack || e);
  if (!env.DB) return;
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS errors (ts INTEGER NOT NULL, method TEXT, path TEXT, error TEXT, stack TEXT)").run();
    await env.DB.prepare("INSERT INTO errors (ts, method, path, error, stack) VALUES (?, ?, ?, ?, ?)")
      .bind(Date.now(), req.method, url.pathname.slice(0, 200), String((e && e.message) || e).slice(0, 300),
            String((e && e.stack) || "").split("\n").slice(0, 4).join(" | ").slice(0, 600)).run();
    await env.DB.prepare("DELETE FROM errors WHERE ts < ?").bind(Date.now() - 30 * DAY * 1000).run();
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

// ---------------------------------------------------------------- short links (pipeline/shortlink.py)
const NETS = { y: "youtube", i: "instagram", t: "tiktok", x: "x" };
let SOCIAL = null, SOCIAL_AT = 0;
async function shortLink(env, url) {
  const m = url.pathname.match(/^\/v\/([yitx])([0-9a-z]{5})(e?)\/?$/);
  const lang = m && m[3] ? "en" : "pt";
  let path = `/${lang}/`;
  if (m) {
    if (!SOCIAL || Date.now() - SOCIAL_AT > 600000) {
      const r = await env.ASSETS.fetch(new Request(new URL("/dados/social.json", url)));
      SOCIAL = r.ok ? await r.json() : { items: [] };
      SOCIAL_AT = Date.now();
    }
    const it = (SOCIAL.items || []).find(x => x.c === m[2]);
    path = (it && it.lang && (it.lang[lang] || it.lang.pt) || {}).url || path;
  }
  const to = new URL(path, url);
  to.search = `utm_source=${m ? NETS[m[1]] : "x"}&utm_medium=social&utm_campaign=lineup`;
  return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "public, max-age=600" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/auth/google") return await authStart(req, env, url);
      if (url.pathname === "/auth/google/callback") return await authCallback(req, env, url);
      if (url.pathname === "/auth/faceit") return await faceitStart(req, env, url);
      if (url.pathname === "/auth/faceit/callback") return await faceitCallback(req, env, url);
      if (url.pathname === "/auth/steam") return await steamStart(req, env, url);
      if (url.pathname === "/auth/steam/callback") return await steamCallback(req, env, url);
      if (url.pathname.startsWith("/v/")) return await shortLink(env, url);
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
