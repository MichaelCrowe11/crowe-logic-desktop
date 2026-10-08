/* Shared portal response contract. Session URLs stay inside the native bridge. */
(function (root) {
  "use strict";
  const EMAIL_LOGIN = "https://pay.crowelogic.com/p/login/28EbJ270N4W38SV32t3gk00";
  function result(response) {
    const status = Number(response && response.status);
    if (status === 401) return { error: "Sign in with Crowe ID to manage billing." };
    if (status === 404) return { error: "No billing account was found for this Crowe ID. You can verify your billing email instead." };
    if (!(status >= 200 && status < 300)) return { error: "The billing service is unavailable. You can verify your billing email instead." };
    try {
      const data = response.data || {};
      const url = new URL(data.portal_url || data.url);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !["billing.stripe.com", "pay.crowelogic.com"].includes(url.hostname) ||
          !url.pathname.startsWith("/p/session/")) throw new Error("Invalid portal");
      return { url: url.toString() };
    } catch { return { error: "Billing returned an invalid portal address. You can verify your billing email instead." }; }
  }
  const api = { result, EMAIL_LOGIN };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CroweBillingPortal = api;
})(typeof window === "object" ? window : globalThis);
