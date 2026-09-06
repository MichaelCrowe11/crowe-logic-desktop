/* Phone detection for the mobile shell: on a coarse-pointer or narrow window,
   load mobile-ui.js, which re-applies the web's welcome copy over the phone
   chrome's (which otherwise promises a paired desktop). External file rather
   than an inline script so the page can run under a strict
   Content-Security-Policy with no 'unsafe-inline'. */
(function () {
  var phone = false;
  try {
    phone = window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 820px)").matches;
  } catch (e) {}
  if (!phone) return;
  var s = document.createElement("script");
  s.onload = function () { try { window.dispatchEvent(new Event("crowe:mobile-ui")); } catch (e) {} };
  s.src = "mobile-ui.js?v=1787432400000";
  document.body.appendChild(s);
})();
