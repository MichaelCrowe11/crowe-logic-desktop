'use strict';
const { createHash } = require('node:crypto');
const { json, canonical } = require('../farm/validation');
const { fault, fields } = require('../vision/validation');
const LIMITS = Object.freeze({ sourceBytes: 8 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024, entryBytes: 4 * 1024 * 1024, entries: 256, ratio: 200, xmlNodes: 80000, xmlDepth: 40, textChars: 1000000, cellChars: 32768, cells: 20000, rows: 10000, columns: 256, sheets: 32, pages: 100, candidates: 200, fields: 64, responseBytes: 256 * 1024, extractionMs: 15000, stageBytes: 24 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => digest(canonical(value));
function reject(code, message) { throw fault(code, message); }
function bounded(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) reject('VALIDATION', `Invalid ${label}.`);
  return value;
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function snapshot(value, max = LIMITS.stageBytes) { return JSON.parse(json(value, max)); }
function utf8(bytes) {
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { reject('ENCODING', 'Only valid UTF-8 text/XML is supported.'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) reject('ENCODING', 'Binary or unsupported control characters in text.');
  return value;
}
function element(elements, locator, raw, value = raw, valueType = 'text', uncertainty = [], extra = {}) {
  if (elements.length >= LIMITS.cells || raw.length > LIMITS.cellChars || (typeof value === 'string' && value.length > LIMITS.cellChars)) reject('CONTENT_LIMIT', 'Document exceeds supported cell/text limits.');
  elements.push({ id: `e${elements.length + 1}`, locator, raw, value, valueType, uncertainty, ...extra });
}
module.exports = { LIMITS, digest, hash, reject, bounded, freeze, snapshot, utf8, element, fields };
