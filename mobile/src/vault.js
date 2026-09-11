/* The vault: the phone's secrets go to the Keychain, not to Preferences.
 *
 * mobile-bridge.js keeps one record, "config", that carries the access and
 * refresh tokens. Its store asks window.croweVault first for that record; this
 * file provides it over the CroweVault plugin (ios/App/App/CroweVault.swift).
 * Anything else the bridge stores stays in Preferences, unchanged.
 *
 * Migration is one-way and happens on the first read: a "config" still sitting
 * in Preferences is copied into the Keychain and then removed from Preferences,
 * so an update from 2410-era builds keeps the person signed in and leaves no
 * token behind in the plist. Without the plugin (browser, Android for now)
 * croweVault is not defined and the store behaves exactly as before.
 *
 * Load order: before mobile-bridge.js.
 */
(() => {
  const Cap = window.Capacitor;
  const Vault = Cap && Cap.Plugins && Cap.Plugins.CroweVault;
  if (!Vault || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  const Preferences = Cap.Plugins.Preferences;
  const KEYS = new Set(["config"]);
  const migrated = new Set();

  async function migrate(key) {
    if (migrated.has(key) || !Preferences) return;
    migrated.add(key);
    try {
      const { value } = await Vault.get({ key });
      if (value) return;                                  // the Keychain already has it
      const old = await Preferences.get({ key });
      if (old && old.value) {
        await Vault.set({ key, value: old.value });
        await Preferences.remove({ key });
      }
    } catch { /* a failed migration leaves Preferences as the source, as before */ migrated.delete(key); }
  }

  /* A Keychain refusal (any SecItem status other than success or not-found)
     must not read as "signed out". The bridge asks this object first and never
     Preferences for a handled key, so the fallback lives here: a rejected read
     answers from Preferences and leaves the key unmigrated; a rejected write
     lands in Preferences, where the next successful migrate() will pick it up. */
  const fromPrefs = async (key) => { if (!Preferences) return null; const { value } = await Preferences.get({ key }); return value || null; };
  window.croweVault = {
    handles: (key) => KEYS.has(key),
    async get(key) {
      await migrate(key);
      try { const { value } = await Vault.get({ key }); return value || (migrated.has(key) ? null : await fromPrefs(key)); }
      catch { migrated.delete(key); return fromPrefs(key); }
    },
    async set(key, value) {
      try { await Vault.set({ key, value }); migrated.add(key); }
      catch { migrated.delete(key); if (Preferences) await Preferences.set({ key, value }); else throw new Error("no store accepted the write"); }
    },
    async remove(key) {
      try { await Vault.remove({ key }); } catch { /* nothing to remove is not a failure */ }
      if (Preferences) { try { await Preferences.remove({ key }); } catch { /* same */ } }
    },
  };
})();
