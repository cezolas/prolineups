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

  // Captions of the style-v2 grenade videos: the video has no text, the page draws it in its own language
  // (list of {a: start s, b: end s, x: text, h: words in gold}), sized to the picture actually shown.
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // mouse with the button(s) to press in red (same drawing as the pages and the social videos)
  function mouse(click, label) {
    if (!/^(left|right|both)$/.test(click || "")) return "";
    const R = "#e53935", W = "#fff", lf = click !== "right" ? R : W, rf = click !== "left" ? R : W;
    const body = "M12 1.5C6.2 1.5 2 5.7 2 11.5v11C2 28.3 6.2 32.5 12 32.5s10-4.2 10-10v-11C22 5.7 17.8 1.5 12 1.5z";
    return `<svg class="mouse-ic" viewBox="0 0 24 34" role="img" aria-label="${esc(label || click)}"><path d="${body}" fill="${W}"/>` +
      `<path d="M12 1.5C6.2 1.5 2 5.7 2 11.5V13h10z" fill="${lf}"/><path d="M12 1.5c5.8 0 10 4.2 10 10V13H12z" fill="${rf}"/>` +
      `<path d="${body}M12 1.5V13M2 13h20" fill="none" stroke="#111" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }
  window.PNmouse = mouse;

  function caps(v, list) {
    v._caps = list || [];
    const box = v.parentElement;
    if (getComputedStyle(box).position === "static") box.style.position = "relative";
    let el = box.querySelector(":scope > .vcap");
    if (!el) { el = document.createElement("div"); el.className = "vcap"; el.setAttribute("aria-hidden", "true"); box.appendChild(el); }
    const place = () => {
      const vw = v.videoWidth || 9, vh = v.videoHeight || 16;
      const dw = Math.min(v.clientWidth, v.clientHeight * vw / vh), dh = dw * vh / vw;
      el.style.left = `${v.offsetLeft + (v.clientWidth - dw) / 2}px`;
      el.style.width = `${dw}px`;
      el.style.top = `${v.offsetTop + (v.clientHeight - dh) / 2 + dh * 0.15}px`;
      el.style.fontSize = `${Math.max(12, dw * 0.068)}px`;
      el.style.setProperty("--stroke", `${Math.max(2, dw * 0.009)}px`);
    };
    const draw = () => {
      const t = v.currentTime, c = v._caps.find((x) => t >= x.a && t < x.b);
      const html = c ? (c.h ? esc(c.x).replace(esc(c.h), `<b>${esc(c.h)}</b>`) : esc(c.x)) + (c.m ? " " + mouse(c.m) : "") : "";
      if (el._h !== html) { el.innerHTML = html; el._h = html; }
    };
    if (!v._capsBound) {
      v._capsBound = true;
      const loop = () => { draw(); if (!v.paused) requestAnimationFrame(loop); };
      v.addEventListener("play", () => { place(); loop(); });
      v.addEventListener("seeked", draw);
      v.addEventListener("timeupdate", draw);
      v.addEventListener("loadedmetadata", () => { place(); draw(); });
      addEventListener("resize", place);
    }
    place(); draw();
  }
  window.PNcaps = caps;

  function attach(v) {
    if (v.dataset.caps) { try { caps(v, JSON.parse(v.dataset.caps)); } catch (e) {} }
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
