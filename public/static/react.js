// Like + "report a problem" bar on grenade, execute and play pages (API: /api/react, /api/like, /api/report).
(function () {
  var bar = document.querySelector(".react[data-k]");
  if (!bar) return;
  var k = bar.dataset.k, I = window.I18N || {};
  var likeBtn = bar.querySelector(".like-btn"), likeN = bar.querySelector(".like-n"), label = likeN.textContent;
  var form = bar.querySelector(".rep-form"), msg = bar.querySelector(".rep-msg");

  function show(d) {
    if (!d || typeof d.likes !== "number") return;
    likeN.textContent = d.likes > 0 ? label + " · " + d.likes : label;
    likeBtn.classList.toggle("on", !!d.liked);
    likeBtn.setAttribute("aria-pressed", d.liked ? "true" : "false");
    if (d.removed) { var box = document.querySelector(".removed-box"); if (box) box.hidden = false; }
  }
  function say(text) { msg.textContent = text; msg.hidden = false; }

  fetch("/api/react?k=" + encodeURIComponent(k), { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; }).then(show).catch(function () {});

  bar.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "like") {
      likeBtn.disabled = true;
      fetch("/api/like", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ k: k }) })
        .then(function (r) { return r.ok ? r.json() : null; }).then(show).catch(function () {})
        .then(function () { likeBtn.disabled = false; });
    } else if (b.dataset.act === "report") {
      form.hidden = !form.hidden; msg.hidden = true;
    } else if (b.dataset.act === "cancel") {
      form.hidden = true;
    }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var reason = (form.querySelector("input[name=reason]:checked") || {}).value || "other";
    var send = form.querySelector("[type=submit]"); send.disabled = true;
    fetch("/api/report", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ k: k, url: location.pathname, reason: reason, note: form.note.value, lang: window.LANG }) })
      .then(function (r) {
        if (r.ok) { form.hidden = true; form.reset(); say(I.report_thanks || "OK"); }
        else say(r.status === 429 ? (I.report_limit || "") : (I.report_fail || ""));
      })
      .catch(function () { say(I.report_fail || ""); })
      .then(function () { send.disabled = false; });
  });
})();
