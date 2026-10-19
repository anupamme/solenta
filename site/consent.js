// Meterbird analytics behind a consent banner. Until "Allow" (and after
// "No thanks") script.js runs cookieless: random per-page ids, nothing
// written to storage. "Allow" starts session replay (replay.js masks all
// text and inputs itself) and a persistent visitor id from the next page.
(() => {
  const KEY = "mb_093966d4791f83a7";
  const load = (file, data) => {
    const s = document.createElement("script");
    s.src = "https://app.meterbird.com/js/" + file;
    s.async = false; // replay.js reads script.js's ids, so keep run order
    Object.assign(s.dataset, { key: KEY }, data);
    document.head.append(s);
  };

  let choice = null;
  try { choice = localStorage.getItem("consent"); } catch {}
  load("script.js", choice === "yes" ? {} : { mode: "cookieless" });
  if (choice === "yes") return load("replay.js");
  if (choice) return;

  const bar = document.createElement("div");
  bar.className = "consent";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Analytics consent");
  bar.innerHTML =
    "<p>Can we keep anonymous usage analytics and session replays? Replays mask every bit of text you see or type.</p>" +
    '<div class="consent-actions">' +
    '<button type="button" class="btn btn-primary" data-consent="yes">Allow</button>' +
    '<button type="button" class="btn btn-ghost" data-consent="no">No thanks</button>' +
    "</div>";
  bar.addEventListener("click", (e) => {
    const v = e.target.closest("[data-consent]")?.dataset.consent;
    if (!v) return;
    try { localStorage.setItem("consent", v); } catch {}
    if (v === "yes") load("replay.js");
    bar.remove();
  });
  document.body.append(bar);
})();
