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

  window.croweVault = {
    handles: (key) => KEYS.has(key),
    async get(key) { await migrate(key); const { value } = await Vault.get({ key }); return value || null; },
    async set(key, value) { migrated.add(key); await Vault.set({ key, value }); },
    async remove(key) { await Vault.remove({ key }); },
  };
})();
