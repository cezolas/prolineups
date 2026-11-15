// Parses the player's demo in the browser (demoparser2 compiled to WebAssembly). Nothing is uploaded.
/* global wasm_bindgen */
importScripts("/static/vendor/demoparser2/demoparser2.js");
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
    if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) throw new Error("bz2");
    self.postMessage({ stage: "header" });
    const header = wasm_bindgen.parseHeader(bytes);
    self.postMessage({ stage: "grenades" });
    // events, not parseGrenades: the WASM binding of parseGrenades returns the player table, not the projectiles
    const ev = wasm_bindgen.parseEvents(bytes, ["grenade_thrown", "smokegrenade_detonate", "flashbang_detonate",
      "hegrenade_detonate", "inferno_startburn"], ["X", "Y", "Z"], []);
    const plain = x => (x instanceof Map ? Object.fromEntries(x) : x);
    self.postMessage({ done: true, header: plain(header), events: ev.map(plain) });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
