"use strict";

try {
  // The look (look.css) before the theme: Instrument is always dark.
  const look = localStorage.getItem("crowe-look") === "instrument" ? "instrument" : "editorial";
  document.body.dataset.look = look;
  document.body.classList.toggle("dark", look === "instrument" || localStorage.getItem("crowe-theme") !== "light");
} catch {
  document.body.dataset.look = "editorial";
  document.body.classList.add("dark");
}
