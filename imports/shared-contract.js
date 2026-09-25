'use strict';
// Source-only server contract. No local candidate/receipt is server authority.
const { digest, fields, bounded, reject } = require('./safety');
const MAX_SOURCE_BYTES = 262144;
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MEDIA = Object.freeze({ csv: 'text/csv', text: 'text/plain', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
function destination(value) {
  fields(value, ['accountId', 'server', 'farmId', 'departmentId']);
  bounded(value.accountId, 256, 'authenticated account'); bounded(value.server, 300, 'shared server');
  if (typeof value.farmId !== 'string' || !ID.test(value.farmId) || (value.departmentId !== null && (typeof value.departmentId !== 'string' || !ID.test(value.departmentId)))) reject('VALIDATION', 'Invalid shared farm or department.');
  return value;
}
function source(stage) {
  const s = stage.source, raw = Buffer.from(s.original, 'base64');
  if (raw.toString('base64') !== s.original || raw.length !== s.byteLength || digest(raw) !== s.digest) reject('STORE_CORRUPT', 'Shared handoff requires the exact immutable original.');
  if (!raw.length || raw.length > MAX_SOURCE_BYTES) reject('SOURCE_LIMIT', `Shared staging accepts 1 to 262144 bytes (256 KiB); this local original is ${raw.length} bytes. Local intake permits 8 MiB. Nothing was uploaded, truncated or converted.`);
  if (typeof s.name !== 'string' || !s.name.trim() || [...s.name].length > 240 || /[\\/\x00-\x1f]/.test(s.name)) reject('SOURCE_NAME', 'Shared staging requires a plain original file name of at most 240 characters. No automatic rename was made.');
  const mediaType = MEDIA[stage.format];
  if (!mediaType) reject('SOURCE_MEDIA', 'This original media type is not supported by shared staging. Images are retained locally; no relabeling or conversion was made.');
  return { fileName: s.name, mediaType, sourceBase64: s.original, sourceDigest: s.digest, byteLength: raw.length };
}
function command(value) {
  fields(value, ['farmId', 'requestId', 'departmentId', 'fileName', 'mediaType', 'sourceBase64']);
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.requestId) || typeof value.farmId !== 'string' || !ID.test(value.farmId) || (value.departmentId !== null && (typeof value.departmentId !== 'string' || !ID.test(value.departmentId)))) reject('VALIDATION', 'Invalid staging identity or scope.');
  if (!Object.values(MEDIA).includes(value.mediaType) || typeof value.sourceBase64 !== 'string' || value.sourceBase64.length > 349528) reject('VALIDATION', 'Unsupported shared source envelope.');
  const raw = Buffer.from(value.sourceBase64, 'base64');
  source({ format: Object.keys(MEDIA).find(k => MEDIA[k] === value.mediaType), source: { name: value.fileName, original: value.sourceBase64, byteLength: raw.length, digest: digest(raw) } });
  if (Buffer.byteLength(JSON.stringify({ action: 'import.stage', payload: value })) > 524288) reject('SOURCE_LIMIT', 'Shared command exceeds 512 KiB.');
  return value;
}
function receipt(value, payload) {
  return value && typeof value.id === 'string' && ID.test(value.id) &&
    value.sourceHash === digest(Buffer.from(payload.sourceBase64, 'base64')) && value.sourceBytes === Buffer.from(payload.sourceBase64, 'base64').length &&
    value.fileName === payload.fileName && value.mediaType === payload.mediaType && value.departmentId === payload.departmentId &&
    value.status === 'staged' && value.revision === 1 && /^[a-f0-9]{64}$/.test(value.revisionHash) &&
    value.ledgerWriteAuthorized === false && Array.isArray(value.candidates) && value.candidates.length === 0;
}
module.exports = { MAX_SOURCE_BYTES, destination, source, command, receipt };
