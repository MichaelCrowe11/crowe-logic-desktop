/* The theme, before anything is drawn. renderer.js applies it too, but that
   file is at the end of the body and the default is dark, so the veil below
   would paint cream and flip a moment later - the flash the veil exists to
   cover, moved rather than removed. Loaded first in <head> via <script src>,
   because that is the one position nothing can paint ahead of, and because a
   strict Content-Security-Policy has no 'unsafe-inline' to offer an inline
   copy. Idempotent: applyTheme() toggles the same class and stays the source
   of truth. */
try {
  document.body.classList.toggle("dark", localStorage.getItem("crowe-theme") !== "light");
} catch (e) {
  document.body.classList.add("dark");
}
