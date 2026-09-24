'use strict';

// Keep this dependency graph credential/storage-service free. This runs before
// main imports any app services, reads config, or registers a writer.
const fs = require('node:fs');
const path = require('node:path');
const { resolveEdition } = require('./app-edition');

function bootstrapEdition({ app, metadata, env = process.env }) {
  const edition = resolveEdition({ metadata, isPackaged: app.isPackaged, env });
  const explicit = app.commandLine.hasSwitch('user-data-dir');
  // Finder launches of an ad-hoc candidate must not open the legacy product's
  // profile, even when both bundles have the same human-readable product name.
  const localPrerelease = app.isPackaged && metadata?.croweLocalPrerelease === true;
  const profileName = edition.profileName + (localPrerelease ? ' Local Prerelease' : '');
  const requested = explicit ? app.commandLine.getSwitchValue('user-data-dir')
    : path.join(app.getPath('appData'), profileName);
  // Never silently replace a malformed explicit override with a real profile.
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('A nonempty user-data-dir is required');
  const absolute = path.resolve(requested);
  fs.mkdirSync(absolute, { recursive: true });
  // Electron's native singleton is scoped to userData. Canonicalize aliases so
  // the same directory cannot acquire a second lock under another spelling.
  // This is the only pre-lock write: creating the selected profile directory.
  const profile = fs.realpathSync(absolute);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);

  let pending = false;
  let windows = null;
  const awaitingReveal = new WeakSet();
  function activate() {
    if (!windows) { pending = true; return; }
    let window = windows.getWindow();
    if (!window || window.isDestroyed()) {
      windows.createWindow();
      window = windows.getWindow();
    }
    if (!window || window.isDestroyed() || awaitingReveal.has(window)) { pending = true; return; }
    pending = false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  // Register before requesting the native lock, not after async migrations or
  // window creation. No second-process argv/URLs are executed or opened here.
  app.on('second-instance', activate);
  app.on('activate', activate);
  const primary = app.requestSingleInstanceLock({ edition: edition.id });
  if (!primary) {
    app.removeListener('second-instance', activate);
    app.removeListener('activate', activate);
    // Caller must exit AND return from its module, before all other imports.
    return { edition, profile, primary: false };
  }
  return {
    edition, profile, primary: true,
    // Register hidden windows before loading their document. Activation waits
    // for the same first-frame/fallback gate that performs their normal reveal.
    windowAwaitingReveal(window) { awaitingReveal.add(window); },
    windowReadyToShow(window) {
      awaitingReveal.delete(window);
      if (pending && windows?.getWindow() === window && !window.isDestroyed()) activate();
    },
    windowsReady(access) {
      windows = access;
      if (pending) activate();
    },
  };
}

module.exports = { bootstrapEdition };
