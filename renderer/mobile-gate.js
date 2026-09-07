(function () {
  "use strict";
  let phone = false;
  try {
    phone = window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 820px)").matches;
  } catch {}
  if (!phone) return;
  const script = document.createElement("script");
  script.onload = () => {
    try { window.dispatchEvent(new Event("crowe:mobile-ui")); } catch {}
  };
  script.src = "mobile-ui.js?v=1788786753000";
  document.body.appendChild(script);
})();
