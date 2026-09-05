// Crowe Logic desktop — the plan, and the way up.
//
// Runs after renderer.js in the packaged app, the way web-ui.js runs after it
// in a browser tab. It exists because the two files that could sell a
// subscription, web-ui.js and web-bridge.js, are both excluded from the
// package by package.json build.files, so the installed app was the one
// surface in the estate with no path from free to paid. A free account could
// see it was free (the badge says "free tier", renderer.js refreshAuth) and
// feel it was free (harness.js routes the turn to the free model), and then
// had nowhere to go.
//
// Three surfaces, matching the web so a member meets the same ladder wherever
// they are:
//
//   · a free account gets an Upgrade pill beside the account badge;
//   · a plan card opens from that pill, from the crowe:paywall event, and
//     once per app session on a free account's first signed-in load;
//   · the higher tiers are chips on the same card, priced from the same
//     catalog, so nobody has to leave to find out what is above Pro.
//
// No price is written in this file. Every number comes from the checkout
// Worker's /v1/catalog, which is also what the web reads, so the two surfaces
// cannot drift apart into two price lists.
//
// What differs from the web: Stripe opens in the system browser, launched by
// the main process, because a card field must never render in a window this
// app controls. That means there is no redirect back into the app to carry
// the new tier, so the card watches for it instead: while the browser has the
// checkout, every window focus spends the refresh token and re-reads the
// claim, and the card says so when the tier lands.

(function () {
  "use strict";

  // Packaged desktop only. The web loads web-ui.js, which owns this job there,
  // and the phone has neither bridge.
  if (typeof window === "undefined" || !window.crowe || !window.crowe.billing) return;
  if (window.Capacitor) return;

  const $ = (id) => document.getElementById(id);
  const billing = window.crowe.billing;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (cents, interval) => `$${Math.round(cents / 100)}${interval ? ` a ${interval}` : ""}`;
  const PLAN_NAMES = { free: "Free", byok: "BYOK", personal: "Personal", pro: "Pro", team: "Team", max: "Max", scale: "Scale", studio: "Studio", business: "Business", enterprise: "Enterprise" };

  // renderer.js addAssistant is not exported, so this reproduces its markup.
  // scripts/test-plan.js asserts the two still match, so a change to the
  // transcript's shape fails the build rather than leaving this card looking
  // like a message from an older version of the app.
  function say(html) {
    const transcript = $("transcript");
    if (!transcript) return null;
    const welcome = transcript.querySelector(".welcome");
    if (welcome) welcome.remove();
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    wrap.innerHTML = '<div class="who"><span class="who-mark" role="img" aria-label="Crowe Logic"></span></div><div class="body"></div>';
    wrap.querySelector(".body").innerHTML = html;
    transcript.appendChild(wrap);
    wrap.scrollIntoView({ block: "end" });
    return wrap;
  }

  function upgradePill(show) {
    let el = $("upgrade-pill");
    if (!show) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement("button");
    el.id = "upgrade-pill"; el.type = "button"; el.className = "ghost sm";
    el.textContent = "Upgrade";
    el.title = "Pro unlocks the frontier models, the rooms and the named agents.";
    el.addEventListener("click", () => planCard({ reason: "pill" }));
    const badge = $("userbadge");
    if (badge && badge.parentNode) badge.parentNode.insertBefore(el, badge);
  }

  /* Watching for the tier, because the browser cannot hand it back.

     The web returns from Stripe through /welcome and a fresh sign-in, so the
     session carries the new tier by construction. Here the payment happens in
     a different application, and the only thing that changes on this machine
     is a claim on a token we have to go and re-mint. So: on every focus while
     a checkout is outstanding, spend the refresh token and look. Focus rather
     than a timer, because the moment the browser gives the window back is
     exactly the moment worth checking, and a timer would keep asking the
     identity server about an account that walked away from the tab. */
  let watching = false;
  function watchForUpgrade(card) {
    if (watching) return;
    watching = true;
    const note = card && card.querySelector(".plan-note");
    const onFocus = async () => {
      let r = null;
      try { r = await billing.refresh(); } catch (_) { r = null; }
      const plan = r && r.plan;
      if (plan && plan.paid) {
        window.removeEventListener("focus", onFocus);
        watching = false;
        upgradePill(false);
        const wrap = card && card.closest(".msg");
        if (wrap) wrap.remove();
        say(`<p class="said">${esc(PLAN_NAMES[plan.tier] || plan.tier)} is active on ${esc(plan.email)}. The frontier models, the rooms and the named agents are open.</p>`);
        /* The badge is renderer.js's, so ask it to re-read rather than writing
           the account line from here. Two events, not one, and in one
           direction each: `crowe:auth-recheck` is "go and look" and only this
           file sends it, `crowe:auth-changed` is "I looked" and only
           refreshAuth sends it. One shared event would have refreshAuth
           answering its own announcement forever. */
        try { window.dispatchEvent(new CustomEvent("crowe:auth-recheck")); } catch (_) {}
      } else if (note) {
        note.textContent = "Still on the free plan here. If you have paid, it can take a moment to land; this window checks again each time you come back to it.";
      }
    };
    window.addEventListener("focus", onFocus);
  }

  async function planCard({ reason } = {}) {
    const transcript = $("transcript");
    if (!transcript) return;
    const prior = transcript.querySelector(".plan-card");
    if (prior) { prior.scrollIntoView({ block: "nearest" }); return; }
    const wrap = say([
      '<div class="plan-card">',
      '<div class="plan-head"><b>Crowe Logic Pro</b><span class="plan-price">reading the price</span></div>',
      '<p class="said plan-why"></p>',
      '<ul class="plan-feats"></ul>',
      '<div class="plan-row"><button type="button" class="primary plan-go">Upgrade with Stripe</button><button type="button" class="ghost plan-later">Not now</button></div>',
      '<div class="plan-more" hidden><span class="plan-more-label">Need more?</span><div class="plan-more-row"></div></div>',
      '<p class="hint plan-note"></p>',
      "</div>",
    ].join(""));
    if (!wrap) return;
    const card = wrap.querySelector(".plan-card");
    card.querySelector(".plan-why").textContent =
      (reason === "paywall" ? "That turn needs Pro. " : "") +
      "One subscription unlocks every Crowe Logic surface: this app, the rooms and named agents, the phone app, and the CLI.";
    const priceEl = card.querySelector(".plan-price");
    const feats = card.querySelector(".plan-feats");

    // One read of the catalog for both the Pro price and the tiers above it.
    let cat = null;
    try { cat = await billing.catalog(); } catch (_) { cat = null; }
    const ladder = (cat && !cat.error && cat.ladder) || [];
    const pro = ladder.find((i) => i.slug === "pro") || null;
    if (pro && pro.amount) {
      priceEl.textContent = money(pro.amount, pro.interval);
      feats.innerHTML = (pro.features || []).slice(0, 6).map((f) => `<li>${esc(f)}</li>`).join("");
    } else {
      // The Worker is the only place a price may come from, so when it does
      // not answer the card says nothing about money rather than guessing.
      priceEl.textContent = "price at checkout";
    }

    /* One path to Stripe, shared by the Pro button and every higher chip. The
       main process posts {slug, email} and opens the browser itself; the reply
       says it opened, or why it did not. Nothing here touches a card. */
    const goCheckout = async (slug, btn, restore) => {
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = "Opening Stripe";
      let r = null;
      try { r = await billing.checkout(slug); } catch (_) { r = null; }
      btn.disabled = false;
      btn.textContent = restore || was;
      if (r && r.ok) {
        card.querySelector(".plan-note").textContent =
          "Stripe is open in your browser. Finish there and come back to this window; the plan lands on this Crowe ID on its own.";
        watchForUpgrade(card);
        return;
      }
      card.querySelector(".plan-note").textContent = (r && r.error) || "Checkout is not answering. Try again in a moment.";
    };
    card.querySelector(".plan-go").addEventListener("click", (e) => goCheckout("pro", e.currentTarget, "Upgrade with Stripe"));

    // The tiers above Pro, as chips. Silent when the catalog does not list
    // them, so an older Worker never draws an empty row. Anything the catalog
    // marks contactOnly (Enterprise) has no amount and no Checkout session to
    // mint, so it is not offered as a button here.
    const higher = ladder.filter((i) => ["scale", "studio", "business"].includes(i.slug) && i.amount && i.available && !i.contactOnly);
    if (higher.length) {
      const more = card.querySelector(".plan-more");
      const row = card.querySelector(".plan-more-row");
      row.innerHTML = higher.map((i) =>
        `<button type="button" class="ghost sm plan-tier" data-slug="${esc(i.slug)}" title="${esc((i.features || [])[0] || i.tagline || "")}">${esc(String(i.name).replace(/^Crowe Logic /, ""))} · ${money(i.amount, i.interval)}</button>`
      ).join("");
      row.querySelectorAll(".plan-tier").forEach((btn) =>
        btn.addEventListener("click", (e) => goCheckout(e.currentTarget.dataset.slug, e.currentTarget)));
      more.hidden = false;
    }
    card.querySelector(".plan-later").addEventListener("click", () => wrap.remove());
  }

  // The harness routes a free account to the free model rather than letting a
  // 403 be the first sign of the plan, so on the desktop the paywall is an
  // event the shell can raise rather than a status code coming back. Wired
  // here so raising it is all any caller has to do.
  window.addEventListener("crowe:paywall", () => planCard({ reason: "paywall" }));

  // Offered once per app session, not once per window focus: a card that
  // reappears every time you come back to the app is an advertisement.
  let offered = false;
  async function evaluate() {
    let p = null;
    try { p = await billing.plan(); } catch (_) { p = null; }
    const signedIn = Boolean(p && p.email);
    const free = Boolean(p && p.known && !p.paid);
    upgradePill(signedIn && free);
    if (signedIn && free && !offered) { offered = true; planCard({ reason: "free" }); }
  }
  window.addEventListener("crowe:auth-changed", evaluate);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", evaluate);
  else evaluate();
})();
