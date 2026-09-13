/* The vault: the phone's secrets go to native secure storage, not Preferences.
 *
 * mobile-bridge.js keeps one record, "config", that carries the access token,
 * refresh token, remote pairing credential and provider keys. Its store asks
 * window.croweVault first for that record; this file routes it to CroweVault
 * (Keychain on iOS, Android Keystore-backed AES-GCM on Android).
 *
 * Migration is one-way and happens on the first read: a config still sitting
 * in Preferences is copied into secure storage and then removed. A native
 * build without the plugin fails closed. A missing registration or temporarily
 * unavailable vault must never turn into a plaintext credential write.
 *
 * The browser preview has no native store and keeps its existing localStorage
 * behavior. Load this file before mobile-bridge.js.
 */
(() => {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  const Vault = Cap.Plugins && Cap.Plugins.CroweVault;
  const Preferences = Cap.Plugins && Cap.Plugins.Preferences;
  const KEYS = new Set(["config"]);
  const migrated = new Set();

  if (!Vault) {
    window.croweVault = {
      secure: false,
      handles: (key) => KEYS.has(key),
      async get() { return null; },
      async set() { throw new Error("native secure storage is unavailable"); },
      async remove(key) { if (Preferences) await Preferences.remove({ key }); },
    };
    return;
  }

  async function migrate(key) {
    if (migrated.has(key) || !Preferences) return;
    const { value } = await Vault.get({ key });
    if (!value) {
      const old = await Preferences.get({ key });
      if (old && old.value) await Vault.set({ key, value: old.value });
    }
    // Remove even an empty or stale record once the secure store has answered.
    await Preferences.remove({ key });
    migrated.add(key);
  }

  /* A secure-store refusal surfaces as signed-out/unavailable. Retaining a
     legacy Preferences record for a later migration is safe; reading or
     writing it after a vault failure is not. */
  window.croweVault = {
    secure: true,
    handles: (key) => KEYS.has(key),
    async get(key) {
      try {
        await migrate(key);
        const { value } = await Vault.get({ key });
        return value || null;
      } catch {
        migrated.delete(key);
        return null;
      }
    },
    async set(key, value) {
      await Vault.set({ key, value });
      migrated.add(key);
      if (Preferences) await Preferences.remove({ key });
    },
    async remove(key) {
      try { await Vault.remove({ key }); } catch { /* nothing to remove is not a failure */ }
      if (Preferences) { try { await Preferences.remove({ key }); } catch { /* same */ } }
    },
  };
})();
