/* A visible account surface shared by desktop and phone. */
(() => {
  "use strict";
  const c = window.crowe, $ = id => document.getElementById(id);
  const section = $("account-settings");
  if (!c?.auth || !section) return;
  let generation = 0, busy = false, billingOpen = false;
  const notice = message => { $("account-notice").textContent = message; };
  async function paint() {
    const current = ++generation;
    try {
      const { user } = await c.auth.status();
      if (current !== generation) return;
      const signedIn = Boolean(user?.email);
      $("account-email").textContent = signedIn ? user.email : "You are signed out.";
      $("account-plan").textContent = signedIn ? `Plan: ${user.tier || "Free"}` : "Sign in to see your plan and billing.";
      for (const id of ["account-billing", "account-email-billing", "account-refresh", "account-signout"]) $(id).hidden = !signedIn;
      $("account-signin").hidden = signedIn;
    } catch { notice("Your account could not be read. Try again."); }
  }
  function openAccount() {
    $("settings-btn").click();
    if (document.body.classList.contains("mobile") && !document.body.classList.contains("sidebar-collapsed")) $("sidebar-toggle").click();
    // Settings reads configuration before it opens. Observe that transition
    // rather than racing a timeout against native storage.
    const reveal = () => { section.scrollIntoView({ block: "start" }); $("account-heading").focus({ preventScroll: true }); };
    if (!$("settings").classList.contains("hidden")) reveal();
    else {
      const observer = new MutationObserver(() => {
        if (!$("settings").classList.contains("hidden")) { observer.disconnect(); reveal(); }
      });
      observer.observe($("settings"), { attributes: true, attributeFilter: ["class"] });
      setTimeout(() => observer.disconnect(), 10000);
    }
    paint();
  }
  $("account-nav").addEventListener("click", openAccount);
  window.addEventListener("crowe:account", openAccount);
  $("settings-btn").addEventListener("click", paint);
  $("account-signin").addEventListener("click", () => $("signin").click());
  async function action(button, task) {
    if (busy) return;
    busy = true; button.disabled = true; section.setAttribute("aria-busy", "true"); notice("");
    try { await task(); } catch { notice("That action could not be completed. Try again."); }
    finally { busy = false; button.disabled = false; section.removeAttribute("aria-busy"); }
  }
  $("account-billing").addEventListener("click", e => action(e.currentTarget, async () => {
    const result = await c.license.billing();
    if (!result?.ok) return notice(result?.error || "Billing is unavailable. Verify your billing email instead.");
    billingOpen = true;
    notice("Billing is open in your browser. Return here after making changes.");
  }));
  $("account-email-billing").addEventListener("click", e => action(e.currentTarget, async () => {
    const result = await c.license.billing({ emailVerification: true });
    if (!result?.ok) return notice(result?.error || "The billing browser could not be opened.");
    billingOpen = true;
    notice("Enter your billing email in Stripe. Stripe sends a verification link to that address.");
  }));
  async function refresh() {
    const result = await c.billing.refresh();
    await paint();
    window.dispatchEvent(new CustomEvent("crowe:auth-recheck"));
    notice(result?.ok ? "Account refreshed." : "The plan could not be refreshed yet. Try again after billing finishes.");
  }
  $("account-refresh").addEventListener("click", e => action(e.currentTarget, refresh));
  $("account-signout").addEventListener("click", e => action(e.currentTarget, async () => {
    generation++; billingOpen = false;
    window.croweSpeak?.stop?.();
    const result = await c.auth.logout();
    if (!result?.ok) return notice(result?.error || "Sign-out did not finish. Try again.");
    $("cfg-token").value = "";
    window.dispatchEvent(new CustomEvent("crowe:auth-recheck"));
    await paint();
    if (document.body.classList.contains("mobile")) {
      // Clears the mounted transcript, terminal buffers and drafts after the
      // bridge has removed this account's persisted state.
      location.reload();
    } else notice("Signed out on this device.");
  }));
  window.addEventListener("focus", () => { if (billingOpen && !busy) action($("account-refresh"), refresh); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && billingOpen && !busy) action($("account-refresh"), refresh); });
  window.addEventListener("crowe:auth-changed", paint);
  paint();
})();
