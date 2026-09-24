'use strict';
const crypto = require('node:crypto');
const { canonical, json, plain } = require('../farm/validation');
const MODEL = 'crowelm-vision';
const NOTICE_VERSION = 'vision-disclosure-1';
const PROMPT_VERSION = 'vision-advisory-1';
const LIMITATIONS = 'Photo-only advisory observations, not a diagnosis, species identification, edibility determination, certification or regulatory approval. Verify in person. Saving creates a notebook note only; it never changes the compliance ledger.';
const UNAVAILABLE = 'Desktop Vision is unavailable until the metered gateway recipient, engine and no-fallback routing contract are independently verified. No photo has been sent. Local notebook work remains available.';
const fault = (code, message) => Object.assign(new Error(message), { code });
const hash = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
function fields(value, allowed, required = allowed) {
  if (!plain(value) || Reflect.ownKeys(value).some(k => !allowed.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value')) || required.some(k => !Object.hasOwn(value, k))) throw fault('VALIDATION', 'Unsupported Vision request fields.');
  return value;
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw fault('VALIDATION', `Invalid ${label}.`);
  return value;
}
function target(value) {
  fields(value, ['type', 'id']);
  if (!['blocks', 'flushes'].includes(value.type)) throw fault('VALIDATION', 'Select a notebook block or harvest.');
  text(value.id, 200, 'target ID');
  return { type: value.type, id: value.id };
}
const CONTEXT_FIELDS = Object.freeze({ blocks: ['code', 'species', 'strain', 'substrate', 'spawned', 'stage'], flushes: ['block', 'n', 'date', 'weight', 'grade'] });
function contextOf(type, row) {
  const context = {};
  for (const key of CONTEXT_FIELDS[type]) if (Object.hasOwn(row, key)) {
    if (typeof row[key] !== 'string' || row[key].length > 2000) throw fault('VALIDATION', 'Selected notebook fields exceed the supported text limits.');
    context[key] = row[key];
  }
  return context;
}
// Only a trusted composition root can supply this adapter contract. Production
// currently supplies none: a requested alias is NOT proof of a routed engine.
function contract(value) {
  fields(value, ['alias', 'engine', 'provider', 'recipient', 'revision', 'metered', 'noFallback', 'toolFree', 'boundedResponse']);
  if (value.alias !== MODEL || ['metered', 'noFallback', 'toolFree', 'boundedResponse'].some(k => value[k] !== true)) throw fault('UNAVAILABLE', UNAVAILABLE);
  for (const key of ['engine', 'provider', 'recipient', 'revision']) text(value[key], 300, 'verified routing contract');
  return Object.freeze({ ...value });
}
function findings(response, route) {
  // Raw-response adapter must enforce its byte ceiling while reading, not after
  // buffering. This second bound protects the host against an invalid adapter.
  try { json(response, 32768); } catch { throw fault('RESPONSE_LIMIT', 'Vision response exceeded the bounded JSON contract.'); }
  fields(response, ['content', 'provenance', 'toolCalls']);
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length) throw fault('TOOLS_REFUSED', 'Vision cannot accept tool calls.');
  const p = response.provenance;
  fields(p, ['alias', 'engine', 'provider', 'recipient', 'revision', 'requestId']);
  for (const key of ['alias', 'engine', 'provider', 'recipient', 'revision']) if (p[key] !== route[key]) throw fault('PROVENANCE_UNVERIFIED', 'Gateway routing provenance was missing or did not match the disclosed recipient and engine.');
  text(p.requestId, 200, 'gateway request ID');
  fields(response.content, ['findings']);
  if (!Array.isArray(response.content.findings) || !response.content.findings.length || response.content.findings.length > 8) throw fault('VALIDATION', 'Vision must return one to eight advisory findings.');
  const out = response.content.findings.map((item, i) => {
    fields(item, ['observation', 'uncertainty']);
    return { id: `finding-${i + 1}`, observation: text(item.observation, 1500, 'observation'), uncertainty: text(item.uncertainty, 600, 'uncertainty') };
  });
  return { findings: out, provenance: { ...p } };
}
module.exports = { MODEL, NOTICE_VERSION, PROMPT_VERSION, LIMITATIONS, UNAVAILABLE, fault, hash, fields, text, target, contextOf, contract, findings };
