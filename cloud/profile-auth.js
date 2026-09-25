'use strict';

// Storage belongs to the already-selected Electron profile. Only the original
// Desktop default profile may consult the historical CLI file, and it is never
// changed here. The explicit-profile switch is intent, even if its path happens
// to equal the default. No renderer configuration can enable this compatibility.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_STORE_BYTES = 1024 * 1024;

function createProfileAuth({ edition, explicitProfile, getProfile, getHome, safeStorage,
  isPackaged, allowPlaintext = false }) {
  if (!['desktop', 'developers', 'mycology'].includes(edition)) throw new Error('Unknown auth edition');
  if (typeof explicitProfile !== 'boolean') throw new Error('Explicit profile policy is required');
  const localLegacy = edition === 'desktop';
  const globalLegacy = localLegacy && !explicitProfile;
  const filename = (name) => path.join(getProfile(), name);
  function present(file) {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  function bytes(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_STORE_BYTES) {
      throw new Error('Credential store is not a bounded regular file');
    }
    return fs.readFileSync(file);
  }
  function object(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credential store');
    return value;
  }
  function read(name, plaintext) {
    try {
      const raw = bytes(filename(name));
      if (safeStorage.isEncryptionAvailable()) return object(safeStorage.decryptString(raw));
      if (plaintext && allowPlaintext && !isPackaged) return object(raw.toString('utf8'));
    } catch { /* unavailable/corrupt means signed out, never a legacy fallback */ }
    return {};
  }
  function write(name, value, plaintext) {
    const text = JSON.stringify(value);
    let data;
    if (safeStorage.isEncryptionAvailable()) data = safeStorage.encryptString(text);
    else if (plaintext && allowPlaintext && !isPackaged) data = Buffer.from(text);
    else throw new Error('Native credential encryption is unavailable');
    if (data.length > MAX_STORE_BYTES) throw new Error('Credential store exceeds size limit');
    const dest = filename(name);
    if (present(dest)) bytes(dest); // Reject links/non-files rather than following them.
    const tmp = filename(`.${name}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, dest);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function migrationTokens() {
    // Existence, not successful decryption, is the one-time marker. In
    // particular, an empty signed-out store must never resurrect CLI tokens.
    if (!localLegacy || present(filename('auth.bin'))) return null;
    let local = {}, global = {};
    try { local = object(bytes(filename('config.json')).toString('utf8')); } catch {}
    if (typeof local.token === 'string' && local.token || typeof local.refreshToken === 'string' && local.refreshToken) {
      return { token: typeof local.token === 'string' ? local.token : '',
        refreshToken: typeof local.refreshToken === 'string' ? local.refreshToken : '' };
    }
    if (!globalLegacy) return null;
    try { global = object(bytes(path.join(getHome(), '.config', 'crowe-logic', 'auth.json')).toString('utf8')); } catch {}
    const token = typeof global.access_token === 'string' ? global.access_token : '';
    const refreshToken = typeof global.refresh_token === 'string' ? global.refresh_token : '';
    return token || refreshToken ? { token, refreshToken } : null;
  }
  return Object.freeze({
    readAuth: () => read('auth.bin', true),
    writeAuth: (value) => write('auth.bin', value, true),
    readKeys: () => read('credentials.bin', false),
    writeKeys: (value) => write('credentials.bin', value, false),
    migrationTokens,
  });
}

// Synchronous commit guards pair with synchronous store writes. No await is
// allowed between the validity check and commit, so logout cannot be overtaken
// by an earlier refresh or authorization-code exchange finishing later.
function createAuthSession() {
  let generation = 0;
  let refreshing = null;
  return {
    generation: () => generation,
    invalidate() { generation++; refreshing = null; return generation; },
    isCurrent: (value) => value === generation,
    refresh(work) {
      if (refreshing) return refreshing.promise;
      const entry = { generation, promise: null };
      entry.promise = Promise.resolve().then(() => work(entry.generation)).finally(() => {
        if (refreshing === entry) refreshing = null;
      });
      refreshing = entry;
      return entry.promise;
    },
  };
}

module.exports = { createProfileAuth, createAuthSession };
