"use strict";

try {
  document.body.classList.toggle("dark", localStorage.getItem("crowe-theme") !== "light");
} catch {
  document.body.classList.add("dark");
}
