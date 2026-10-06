const draft = document.getElementById("draft");
const saved = document.getElementById("saved");
const status = document.getElementById("status");
const saveButton = document.getElementById("save");
const doneButton = document.getElementById("done");
let savedText = "";
let revision;
let busy = false;
function position() {
  const before = draft.value.slice(0, draft.selectionStart).split("\n");
  document.getElementById("position").textContent = `Ln ${before.length}, Col ${before.at(-1).length + 1}`;
}
function message(text, error = false) { status.textContent = text; status.classList.toggle("error", error); }
async function save(done = false) {
  if (busy || draft.disabled) return;
  busy = true; draft.disabled = saveButton.disabled = doneButton.disabled = true;
  try {
    const text = draft.value;
    const result = await window.croweDraft.save(text, done, revision);
    if (result.error) { message(result.error, true); return; }
    savedText = text;
    revision = result.revision;
    saved.textContent = draft.value === savedText ? "Saved" : "Unsaved changes";
    message(done ? "Returning to Crowe Logic CLI" : "Saved. Close this window to return to the CLI.");
  } catch (error) { message(error.message, true); }
  finally { busy = false; draft.disabled = saveButton.disabled = doneButton.disabled = false; draft.focus(); }
}
async function close() {
  if (busy || draft.disabled) return;
  busy = true;
  try { const result = await window.croweDraft.close(draft.value, revision); if (result.error) message(result.error, true); }
  catch (error) { message(error.message, true); }
  finally { busy = false; }
}
draft.addEventListener("input", () => {
  const dirty = draft.value !== savedText;
  saved.textContent = dirty ? "Unsaved changes" : "Saved";
  window.croweDraft.dirty(dirty);
  position();
});
for (const event of ["click", "keyup", "select"]) draft.addEventListener(event, position);
saveButton.addEventListener("click", () => save());
doneButton.addEventListener("click", () => save(true));
window.croweDraft.onSave(() => save());
window.croweDraft.onDone(() => save(true));
window.croweDraft.onClose(close);
window.croweDraft.onChanged?.(current => {
  if (draft.value !== savedText || busy) { message("The phone saved a newer revision. Your local edit is preserved; copy it before reloading.", true); return; }
  draft.value = current.text; savedText = current.text; revision = current.revision;
  saved.textContent = "Saved on host"; message("Updated from the paired phone."); position();
});
window.croweDraft.read().then(result => {
  if (result.error) throw new Error(result.error);
  document.getElementById("name").textContent = result.name;
  draft.value = result.text;
  savedText = draft.value;
  revision = result.revision;
  saved.textContent = "Saved";
  draft.disabled = saveButton.disabled = doneButton.disabled = false;
  draft.focus(); position();
}).catch(error => message(error.message, true));
