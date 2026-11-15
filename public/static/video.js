// Video helper for the clips: the static host answers range requests with the whole file, so browsers can't seek
// reliably. On first play each clip (1-3 MB) is loaded into memory as a blob: rewind/forward then always work.
// Adds a small toolbar under every <video data-tools>: -2s, +2s, frame back/forward, 0.25x / 0.5x / 1x.
(() => {
  const T = window.I18N || {};
  const FRAME = 1 / 30;

  async function makeSeekable(v) {
    if (v.dataset.blob || !v.currentSrc && !v.getAttribute("src")) return;
    v.dataset.blob = "loading";
    try {
      const src = v.currentSrc || v.src;
      const blob = await (await fetch(src)).blob();
      const t = v.currentTime, playing = !v.paused, rate = v.playbackRate;
      v.src = URL.createObjectURL(blob);
      v.dataset.blob = "1";
      await new Promise((ok) => v.addEventListener("loadedmetadata", ok, { once: true }));
      v.currentTime = t; v.playbackRate = rate;
      if (playing) v.play().catch(() => {});
    } catch (e) { v.dataset.blob = ""; }
  }

  function toolbar(v) {
    if (v.dataset.toolsReady) return;
    v.dataset.toolsReady = "1";
    const bar = document.createElement("div");
    bar.className = "vtools";
    bar.innerHTML = `
      <button type="button" data-v="back" title="${T.v_back || "-2s"}">⏪ 2s</button>
      <button type="button" data-v="fb" title="${T.v_frame_back || "frame"}">⏮</button>
      <button type="button" data-v="play" title="${T.v_play || "play"}">⏯</button>
      <button type="button" data-v="ff" title="${T.v_frame_fwd || "frame"}">⏭</button>
      <button type="button" data-v="fwd" title="${T.v_fwd || "+2s"}">2s ⏩</button>
      <span class="vt-sep"></span>
      ${[0.25, 0.5, 1].map((r) => `<button type="button" data-rate="${r}"${r === 1 ? ' class="on"' : ""}>${String(r).replace(".", T.dec || ",")}x</button>`).join("")}`;
    v.insertAdjacentElement("afterend", bar);
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      makeSeekable(v);
      const a = b.dataset.v;
      if (a === "play") { v.paused ? v.play().catch(() => {}) : v.pause(); return; }
      if (a === "back") v.currentTime = Math.max(0, v.currentTime - 2);
      if (a === "fwd") v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 2);
      if (a === "fb" || a === "ff") { v.pause(); v.currentTime = Math.max(0, v.currentTime + (a === "ff" ? FRAME : -FRAME)); }
      if (b.dataset.rate) {
        v.playbackRate = +b.dataset.rate;
        bar.querySelectorAll("[data-rate]").forEach((x) => x.classList.toggle("on", x === b));
      }
    });
  }

  function attach(v) {
    toolbar(v);
    v.addEventListener("play", () => makeSeekable(v));
    v.addEventListener("seeking", () => makeSeekable(v));
    if (!v.paused || v.autoplay) makeSeekable(v);
  }
  document.querySelectorAll("video[data-tools]").forEach(attach);
  // videos whose src is set later (play page POV)
  new MutationObserver((ms) => ms.forEach((m) => {
    const v = m.target;
    if (m.type === "attributes" && v.matches("video[data-tools]") && !String(v.getAttribute("src") || "").startsWith("blob:")) v.dataset.blob = "";
  })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["src"] });
})();
