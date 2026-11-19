// Parses the player's demo in the browser (demoparser2 compiled to WebAssembly). Nothing is uploaded.
/* global wasm_bindgen */
importScripts("/static/vendor/demoparser2/demoparser2.js", "/static/vendor/fzstd/fzstd.js");
let ready = null;
let BYTES = null;   // the demo, kept for the 2D review (review.js asks for each round's positions)
const init = () => (ready = ready || wasm_bindgen("/static/vendor/demoparser2/demoparser2_bg.wasm"));

async function gunzip(buf) {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

self.onmessage = async (e) => {
  if (e.data.replay) {   // positions of the 10 players at these ticks (one round of the 2D review)
    try {
      const rows = wasm_bindgen.parseTicks(BYTES, ["X", "Y", "yaw", "team_num", "is_alive"], new Int32Array(e.data.replay))
        .map((x) => (x instanceof Map ? Object.fromEntries(x) : x))
        .map((r) => ({ tick: r.tick, name: r.name, X: r.X, Y: r.Y, yaw: r.yaw, team_num: r.team_num, is_alive: r.is_alive }));
      self.postMessage({ rid: e.data.rid, replay: rows });
    } catch (err) { self.postMessage({ rid: e.data.rid, replay: null, error: String(err && err.message || err) }); }
    return;
  }
  try {
    await init();
    let bytes = new Uint8Array(e.data.buf);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) { self.postMessage({ stage: "unzip" }); bytes = await gunzip(bytes); }
    // FACEIT now serves .dem.zst (Zstandard): decompress with fzstd (MIT, vendored)
    if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) { self.postMessage({ stage: "unzip" }); bytes = fzstd.decompress(bytes); }
    if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) throw new Error("bz2");
    BYTES = bytes;
    self.postMessage({ stage: "header" });
    const header = wasm_bindgen.parseHeader(bytes);
    self.postMessage({ stage: "grenades" });
    // events, not parseGrenades: the WASM binding of parseGrenades returns the player table, not the projectiles
    const ev = wasm_bindgen.parseEvents(bytes, ["grenade_thrown", "smokegrenade_detonate", "flashbang_detonate",
      "hegrenade_detonate", "inferno_startburn", "player_death", "player_blind", "round_end", "round_freeze_end",
      "bomb_planted", "bomb_defused", "bomb_exploded", "round_announce_match_start", "begin_new_match"], ["X", "Y", "Z", "team_num"], []);
    const plain = x => (x instanceof Map ? Object.fromEntries(x) : x);
    const events = ev.map(plain);
    // some demos (e.g. FACEIT) have no grenade_thrown: rebuild it from weapon_fire of the grenade weapons
    if (!events.some(x => x.event_name === "grenade_thrown")) {
      const NADES = new Set(["weapon_smokegrenade", "weapon_flashbang", "weapon_hegrenade", "weapon_molotov", "weapon_incgrenade"]);
      const fires = wasm_bindgen.parseEvents(bytes, ["weapon_fire"], ["X", "Y", "Z", "team_num"], []);
      for (const f0 of fires) {
        const f = plain(f0);
        if (NADES.has(f.weapon)) events.push({ ...f, event_name: "grenade_thrown", weapon: f.weapon.replace("weapon_", "") });
      }
    }
    // CS2 demos don't carry player_blind: read everyone's flash_duration right before/after each flashbang detonation
    const flashes = events.filter(x => x.event_name === "flashbang_detonate");
    if (flashes.length) {
      self.postMessage({ stage: "flashes" });
      const ticks = new Int32Array([...new Set(flashes.flatMap(f => [f.tick - 1, f.tick + 3]))].sort((a, b) => a - b));
      const rows = wasm_bindgen.parseTicks(bytes, ["flash_duration", "team_num"], ticks).map(plain);
      const at = new Map(rows.map(r => [r.tick + ":" + r.steamid, r]));
      for (const f of flashes) {
        const thrower = at.get((f.tick - 1) + ":" + f.user_steamid);
        for (const r of rows) {
          if (r.tick !== f.tick + 3 || String(r.steamid) === String(f.user_steamid)) continue;
          const before = at.get((f.tick - 1) + ":" + r.steamid);
          const dur = (r.flash_duration || 0) - (before ? before.flash_duration || 0 : 0);
          if (dur > 0.05) events.push({ event_name: "player_blind", tick: f.tick, blind_duration: r.flash_duration,
            attacker_name: f.user_name, attacker_team_num: thrower ? thrower.team_num : f.user_team_num,
            user_name: r.name, user_team_num: r.team_num });
        }
      }
    }
    // positions 25-45 s into each round (every 5 s): distance to teammates, for the role guess
    let samples = [];
    const fe = events.filter(x => x.event_name === "round_freeze_end").map(x => x.tick);
    if (fe.length) {
      self.postMessage({ stage: "roles" });
      const st = new Int32Array(fe.flatMap(t => [25, 30, 35, 40, 45].map(s => t + s * 64)));
      samples = wasm_bindgen.parseTicks(bytes, ["X", "Y", "team_num", "is_alive"], st).map(plain)
        .map(r => ({ tick: r.tick, name: r.name, x: r.X, y: r.Y, team: r.team_num, alive: r.is_alive }));
    }
    self.postMessage({ done: true, header: plain(header), events, samples });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
