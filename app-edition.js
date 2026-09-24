'use strict';

// Main resolves this once, before opening a profile. Renderer preferences can
// narrow navigation but are never authority for local-record capabilities.
function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}

const POLICIES = freeze({
  desktop: {
    id: 'desktop',
    productName: 'Crowe Logic',
    appId: 'com.crowelogic.desktop',
    profileName: 'Crowe Logic',
    protocol: null,
    allowedSpaces: ['chat', 'projects'],
    defaultSpaces: ['chat', 'projects'],
    landingSpace: 'chat',
    legacyAccess: false,
    capabilities: { grow: false, farm: false, sense: false, legacyAccess: false },
  },
  developers: {
    id: 'developers',
    productName: 'Crowe Logic for Developers',
    appId: 'com.crowelogic.desktop.developers',
    profileName: 'Crowe Logic for Developers',
    protocol: null,
    allowedSpaces: ['chat', 'projects'],
    defaultSpaces: ['chat', 'projects'],
    landingSpace: 'chat',
    legacyAccess: false,
    capabilities: { grow: false, farm: false, sense: false, legacyAccess: false },
  },
  mycology: {
    id: 'mycology',
    productName: 'Crowe Logic Mycology',
    appId: 'com.crowelogic.desktop.mycology',
    profileName: 'Crowe Logic Mycology',
    protocol: null,
    allowedSpaces: ['farm', 'cultivation', 'messenger', 'chat'],
    defaultSpaces: ['farm', 'cultivation', 'messenger'],
    landingSpace: 'farm',
    legacyAccess: false,
    capabilities: { grow: true, farm: true, sense: true, legacyAccess: false },
  },
});

function policyFor(id) {
  if (typeof id !== 'string' || !Object.hasOwn(POLICIES, id)) {
    throw new Error('Unknown Crowe edition; expected desktop, developers or mycology');
  }
  return POLICIES[id];
}

function selectedSpaces(policy, requested) {
  return policy.allowedSpaces.filter((space) => space === policy.landingSpace || requested.includes(space));
}

// Explicit allowlist: never send package metadata, environment, or profile paths
// to the renderer. Recovery access is separately granted by main for a window;
// it cannot be granted by metadata or by modifying a base descriptor.
function publicEditionDescriptor(edition) {
  const policy = policyFor(edition.id);
  const defaults = Array.isArray(edition.defaultSpaces) ? edition.defaultSpaces : policy.defaultSpaces;
  return freeze({
    id: policy.id,
    productName: policy.productName,
    appId: policy.appId,
    profileName: policy.profileName,
    protocol: policy.protocol,
    allowedSpaces: [...policy.allowedSpaces],
    defaultSpaces: selectedSpaces(policy, defaults),
    landingSpace: policy.landingSpace,
    legacyAccess: false,
    capabilities: { ...policy.capabilities },
  });
}

function resolveEdition({ metadata = {}, isPackaged = true, env = {} } = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Crowe edition metadata must be an object');
  }
  if (typeof isPackaged !== 'boolean') throw new Error('isPackaged must be a boolean');
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Edition environment must be an object');

  // Absence is the legacy Desktop contract. A present but malformed edition is
  // not legacy metadata, and a development override must not hide that error.
  let policy = policyFor(Object.hasOwn(metadata, 'croweEdition') ? metadata.croweEdition : 'desktop');
  if (!isPackaged && Object.hasOwn(env, 'CROWE_EDITION')) policy = policyFor(env.CROWE_EDITION);

  let defaults = policy.defaultSpaces;
  if (Object.hasOwn(env, 'CROWE_SPACES')) {
    if (typeof env.CROWE_SPACES !== 'string') throw new Error('CROWE_SPACES must be a comma-separated string');
    // Unknown/disallowed names are ignored, never converted into capabilities.
    // An explicit empty request means landing only, not "restore all defaults".
    defaults = selectedSpaces(policy, env.CROWE_SPACES.split(',').map((space) => space.trim()));
  }
  return publicEditionDescriptor({ id: policy.id, defaultSpaces: defaults });
}

function editionIconName(edition) {
  return policyFor(edition.id).id === 'mycology' ? 'icon-mycology' : 'icon';
}

module.exports = { resolveEdition, publicEditionDescriptor, editionIconName };
