// Parses the player's demo in the browser (demoparser2 compiled to WebAssembly). Nothing is uploaded.
/* global wasm_bindgen */
importScripts("/static/vendor/demoparser2/demoparser2.js", "/static/vendor/fzstd/fzstd.js");
let ready = null;
const init = () => (ready = ready || wasm_bindgen("/static/vendor/demoparser2/demoparser2_bg.wasm"));

async function gunzip(buf) {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

self.onmessage = async (e) => {
  try {
    await init();
    let bytes = new Uint8Array(e.data.buf);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) { self.postMessage({ stage: "unzip" }); bytes = await gunzip(bytes); }
    // FACEIT now serves .dem.zst (Zstandard): decompress with fzstd (MIT, vendored)
    if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) { self.postMessage({ stage: "unzip" }); bytes = fzstd.decompress(bytes); }
    if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) throw new Error("bz2");
    self.postMessage({ stage: "header" });
    const header = wasm_bindgen.parseHeader(bytes);
    self.postMessage({ stage: "grenades" });
    // events, not parseGrenades: the WASM binding of parseGrenades returns the player table, not the projectiles
    const ev = wasm_bindgen.parseEvents(bytes, ["grenade_thrown", "smokegrenade_detonate", "flashbang_detonate",
      "hegrenade_detonate", "inferno_startburn", "player_death", "player_blind", "round_end"], ["X", "Y", "Z", "team_num"], []);
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
    self.postMessage({ done: true, header: plain(header), events });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
