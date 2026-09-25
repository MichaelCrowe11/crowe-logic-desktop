'use strict';
// Staging only. No ledger/store, IPC, model client, network or subprocess calls.
// The host must keep the returned original/stage and later bind a real operator
// identity. Receipt hashes detect stale/mismatched content, not authorization.
const path = require('node:path');
const { readBounded } = require('../vision/io');
const { dimensions } = require('../vision/image');
const { LIMITS, digest, hash, reject, bounded, freeze, snapshot, utf8, element, fields } = require('./safety');
const { parseOffice } = require('./office');
const VERSION = 'farm-import-1';
const FORMATS = { '.csv': 'csv', '.txt': 'text', '.md': 'text', '.docx': 'docx', '.xlsx': 'xlsx', '.pdf': 'pdf', '.png': 'image', '.jpg': 'image', '.jpeg': 'image' };
function capabilities() {
  let sax = false; try { require.resolve('sax'); sax = true; } catch {}
  return freeze({ csv: true, text: true, docx: sax, xlsx: sax, pdfText: false, pdfPageCount: false, imageHeaderPreflight: true, ocr: false, limitations: ['PDF parser not installed; PDF text and page count unavailable.', 'OOXML support requires installed sax; it is a bounded typed subset, not Office rendering.', 'No built-in OCR or verified remote adapter. No DOC, XLS, XLSM, DOCM, encrypted Office, ZIP64, or non-UTF-8 input.'] });
}
function csv(text) {
  const elements = [], warnings = [], rows = [];
  let i = text.startsWith('﻿') ? 1 : 0, row = 1, column = 1, line = 1;
  if (i === text.length) return { elements, warnings, sheets: [], pageCount: null };
  while (i < text.length) {
    const start = i, startLine = line;
    let value = '';
    if (text[i] === '"') {
      i++; let closed = false;
      while (i < text.length) {
        if (text[i] === '"') { if (text[i + 1] === '"') { value += '"'; i += 2; } else { i++; closed = true; break; } }
        else { if (text[i] === '\n' || (text[i] === '\r' && text[i + 1] !== '\n')) line++; value += text[i++]; }
        if (value.length > LIMITS.cellChars) reject('CONTENT_LIMIT', 'CSV cell exceeds limit.');
      }
      if (!closed || (i < text.length && ![',', '\r', '\n'].includes(text[i]))) reject('CSV_FORMAT', 'Malformed quoted CSV field.');
    } else {
      while (i < text.length && ![',', '\r', '\n'].includes(text[i])) { if (text[i] === '"') reject('CSV_FORMAT', 'Unexpected CSV quote.'); value += text[i++]; if (value.length > LIMITS.cellChars) reject('CONTENT_LIMIT', 'CSV cell exceeds limit.'); }
    }
    const uncertainty = /^[\s]*[=+\-@]/.test(value) ? ['formula_like_text_not_evaluated'] : [];
    element(elements, { row, column, lineStart: startLine, lineEnd: line, charStart: start, charEnd: i, page: null }, text.slice(start, i), value, 'text', uncertainty);
    (rows[row - 1] ||= []).push(value);
    if (row > LIMITS.rows || column > LIMITS.columns) reject('CONTENT_LIMIT', 'CSV row/column limits exceeded.');
    if (i === text.length) break;
    if (text[i] === ',') { i++; column++; if (i === text.length) { element(elements, { row, column, lineStart: line, lineEnd: line, charStart: i, charEnd: i, page: null }, ''); rows[row - 1].push(''); if (column > LIMITS.columns) reject('CONTENT_LIMIT', 'CSV column limit exceeded.'); } continue; }
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    i++; line++; row++; column = 1;
  }
  const headers = rows[0] || [], seen = new Map();
  headers.forEach((value, index) => { if (seen.has(value)) warnings.push({ code: 'DUPLICATE_FIRST_ROW_VALUE', columns: [seen.get(value), index + 1] }); else seen.set(value, index + 1); });
  rows.forEach((r, index) => { if (r.length !== headers.length) warnings.push({ code: 'RAGGED_ROW', row: index + 1, columns: r.length }); });
  const signatures = new Map();
  rows.forEach((r, index) => { const key = JSON.stringify(r); if (signatures.has(key)) warnings.push({ code: 'DUPLICATE_ROW', row: index + 1, duplicateOf: signatures.get(key) }); else signatures.set(key, index + 1); });
  return { elements, warnings, sheets: [], pageCount: null };
}
function textDocument(text) {
  const elements = [];
  let start = text.startsWith('﻿') ? 1 : 0, line = 1;
  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
    element(elements, { line: line++, charStart: start, charEnd: end, page: null }, text.slice(start, end));
    if (text[end] === '\r' && text[end + 1] === '\n') end++;
    start = end + 1;
  }
  return { elements, warnings: [], sheets: [], pageCount: null };
}
function parseBytes(input, metadata) {
  fields(metadata, ['name', 'mime', 'lastModified', 'selectionStamp'], ['name']);
  bounded(metadata.name, 255, 'source name');
  if (path.basename(metadata.name) !== metadata.name || /[\\/]/.test(metadata.name)) reject('VALIDATION', 'Use a basename, not a path, for source metadata.');
  for (const key of ['mime', 'lastModified', 'selectionStamp']) if (metadata[key] !== undefined && metadata[key] !== null) bounded(metadata[key], 300, key);
  if (!Buffer.isBuffer(input) || input.length > LIMITS.sourceBytes) reject('SOURCE_LIMIT', 'Source must be a Buffer within the 8 MiB limit.');
  const bytes = Buffer.from(input), format = FORMATS[path.extname(metadata.name).toLowerCase()];
  const source = { name: metadata.name, declaredMime: metadata.mime ?? null, lastModified: metadata.lastModified ?? null, selectionStamp: metadata.selectionStamp ?? null, byteLength: bytes.length, digest: digest(bytes), encoding: 'base64', original: bytes.toString('base64'), trust: 'untrusted_source' };
  let parsed = { elements: [], warnings: [], sheets: [], pageCount: null }, status = 'parsed';
  if (!format) { status = 'unsupported'; parsed.warnings.push({ code: 'UNSUPPORTED_FORMAT' }); }
  else if (['csv', 'text'].includes(format)) { const text = utf8(bytes); if (text.length > LIMITS.textChars) reject('CONTENT_LIMIT', 'Text exceeds supported limit.'); parsed = format === 'csv' ? csv(text) : textDocument(text); }
  else if (['docx', 'xlsx'].includes(format)) {
    if (!capabilities()[format]) { status = 'unsupported'; parsed.warnings.push({ code: 'XML_PARSER_UNAVAILABLE' }); }
    else parsed = parseOffice(bytes, format);
  } else if (format === 'image') {
    parsed.image = dimensions(bytes); status = 'needs_vision'; parsed.warnings.push({ code: 'IMAGE_NOT_DECODED', detail: 'Header preflight only. Decode/normalize in the existing isolated Vision decoder before any adapter use.' });
  } else {
    if (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 12).toString('ascii')) || !/%%EOF\s*$/.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString('ascii'))) reject('PDF_FORMAT', 'Missing PDF header/end marker.');
    status = 'needs_vision'; parsed.warnings.push({ code: 'PDF_PARSER_UNAVAILABLE', detail: 'Header preflight is not PDF validation. Text, encryption, page count and scan status are unknown. No PDF bytes may be forwarded to OCR until a bounded page renderer validates them.' });
  }
  if (parsed.elements.reduce((n, e) => n + e.raw.length + (typeof e.value === 'string' ? e.value.length : 0), 0) > LIMITS.textChars * 2) reject('CONTENT_LIMIT', 'Aggregate extracted text exceeds limit.');
  const payload = snapshot({ version: VERSION, source, format: format || 'unsupported', status, ...parsed });
  return freeze({ ...payload, stageDigest: hash(payload) });
}
function parseSelected(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) reject('UNSAFE_PATH', 'Select an absolute local filename through the trusted host.');
  const { bytes, stamp } = readBounded(filename, LIMITS.sourceBytes);
  return parseBytes(bytes, { name: path.basename(filename), selectionStamp: stamp });
}
function checkStage(stage) {
  const copy = snapshot(stage); const { stageDigest, ...payload } = copy;
  if (payload.version !== VERSION || hash(payload) !== stageDigest || !payload.source || digest(Buffer.from(payload.source.original, 'base64')) !== payload.source.digest) reject('SOURCE_CHANGED', 'Import stage or original bytes changed.');
  return copy;
}
function sourceRef(stage, locator, elementId = null) { return { sourceDigest: stage.source.digest, stageDigest: stage.stageDigest, elementId, locator }; }
function candidate(stage, kind, candidateFields, provenance) {
  if (!['document_draft', 'log_candidate'].includes(kind)) reject('VALIDATION', 'Select document_draft or log_candidate explicitly.');
  const body = { kind, state: 'unreviewed', sourceDigest: stage.source.digest, stageDigest: stage.stageDigest, fields: candidateFields, provenance, uncertainty: ['untrusted_source_requires_owner_review', ...stage.warnings.map(w => w.code)] };
  return { ...body, id: hash(body) };
}
function createCandidates(stage, requests) { return createCandidatesChecked(checkStage(stage), requests); }
function createCandidatesChecked(stage, requests) {
  requests = snapshot(requests, LIMITS.responseBytes);
  if (stage.status !== 'parsed' || !Array.isArray(requests) || !requests.length || requests.length > LIMITS.candidates) reject('VALIDATION', 'Candidates require a parsed source and bounded explicit selections.');
  const seen = new Set();
  const result = requests.map(request => {
    fields(request, ['kind', 'fields']);
    if (!Array.isArray(request.fields) || !request.fields.length || request.fields.length > LIMITS.fields) reject('VALIDATION', 'Candidate fields exceed limits.');
    const names = new Set();
    const out = request.fields.map(field => {
      fields(field, ['name', 'elementId']); bounded(field.name, 100, 'field name');
      if (names.has(field.name)) reject('VALIDATION', 'Duplicate candidate field name.'); names.add(field.name);
      const e = stage.elements.find(e => e.id === field.elementId); if (!e) reject('SOURCE_REFERENCE', 'Candidate references an unknown element.');
      return { name: field.name, raw: e.raw, value: e.value, valueType: e.valueType, sourceRef: sourceRef(stage, e.locator, e.id), uncertainty: [...e.uncertainty], confidence: null, sourceDetails: { sourceType: e.sourceType ?? null, style: e.style ?? null, formula: e.formula ?? null, formulaAttributes: e.formulaAttributes ?? null, hiddenRow: e.hiddenRow ?? null } };
    });
    const result = candidate(stage, request.kind, out, { method: 'deterministic_parser', version: VERSION });
    if (seen.has(result.id)) reject('DUPLICATE_CANDIDATE', 'Identical selections were supplied more than once.'); seen.add(result.id); return result;
  });
  return freeze(snapshot(result, LIMITS.responseBytes));
}
function routeContract(route) {
  const copy = snapshot(route, 8192);
  fields(copy, ['engine', 'provider', 'recipient', 'revision', 'noFallback', 'toolFree', 'boundedResponse']);
  ['engine', 'provider', 'recipient', 'revision'].forEach(key => bounded(copy[key], 300, key));
  if (['noFallback', 'toolFree', 'boundedResponse'].some(key => copy[key] !== true)) reject('PROVENANCE_UNVERIFIED', 'OCR requires a verified bounded, tool-free, no-fallback adapter contract.');
  return copy;
}
function validateExtraction(stage, response, route) { return validateExtractionChecked(checkStage(stage), response, route); }
function validateExtractionChecked(stage, response, route) {
  route = routeContract(route); response = snapshot(response, LIMITS.responseBytes);
  fields(response, ['sourceDigest', 'stageDigest', 'provenance', 'toolCalls', 'candidates']);
  if (stage.status !== 'needs_vision' || response.sourceDigest !== stage.source.digest || response.stageDigest !== stage.stageDigest) reject('SOURCE_REFERENCE', 'Extraction does not match the staged scan.');
  fields(response.provenance, ['engine', 'provider', 'recipient', 'revision', 'requestId']);
  for (const key of ['engine', 'provider', 'recipient', 'revision']) if (response.provenance[key] !== route[key]) reject('PROVENANCE_UNVERIFIED', 'Extraction route differs from the verified adapter.');
  bounded(response.provenance.requestId, 200, 'request ID');
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length) reject('TOOLS_REFUSED', 'OCR cannot return tool calls.');
  if (!Array.isArray(response.candidates) || !response.candidates.length || response.candidates.length > LIMITS.candidates) reject('VALIDATION', 'Invalid extraction candidates.');
  const ids = new Set();
  const result = response.candidates.map(request => {
    fields(request, ['kind', 'fields']);
    if (!Array.isArray(request.fields) || !request.fields.length || request.fields.length > LIMITS.fields) reject('VALIDATION', 'Invalid extraction fields.');
    const names = new Set();
    const out = request.fields.map(f => {
      fields(f, ['name', 'raw', 'uncertainty', 'confidence', 'locator']);
      bounded(f.name, 100, 'field name'); bounded(f.raw, LIMITS.cellChars, 'OCR transcription', true); bounded(f.uncertainty, 1000, 'explicit OCR uncertainty');
      if (names.has(f.name)) reject('VALIDATION', 'Duplicate OCR field name.'); names.add(f.name);
      if (f.confidence !== null && (typeof f.confidence !== 'number' || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1)) reject('VALIDATION', 'Confidence must be null or a number in [0,1].');
      fields(f.locator, ['page', 'region'], ['page']);
      // This slice has no verified PDF renderer. Never accept fabricated page refs.
      if (stage.format === 'pdf') reject('PDF_RENDERER_UNAVAILABLE', 'PDF OCR requires a verified bounded page renderer, unavailable in this slice.');
      if (f.locator.page !== null) reject('SOURCE_REFERENCE', 'Image source has no document page number.');
      if (f.locator.region !== undefined) {
        if (!Array.isArray(f.locator.region) || f.locator.region.length !== 4 || f.locator.region.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) || f.locator.region[0] >= f.locator.region[2] || f.locator.region[1] >= f.locator.region[3]) reject('SOURCE_REFERENCE', 'Region must be normalized [left,top,right,bottom].');
      }
      return { name: f.name, raw: f.raw, value: f.raw, valueType: 'ocr_text', sourceRef: sourceRef(stage, f.locator), uncertainty: [f.uncertainty, 'ocr_transcription_not_verified'], confidence: f.confidence };
    });
    const result = candidate(stage, request.kind, out, { method: 'ocr', ...response.provenance });
    if (ids.has(result.id)) reject('DUPLICATE_CANDIDATE', 'Duplicate OCR candidate.'); ids.add(result.id); return result;
  });
  return freeze(snapshot(result, LIMITS.responseBytes));
}
async function extractWithAdapter(stage, adapter, { signal } = {}) {
  stage = checkStage(stage);
  if (!adapter) return freeze({ status: 'needs_vision', sourceDigest: stage.source.digest, stageDigest: stage.stageDigest, candidates: [], reason: 'No verified OCR adapter configured.' });
  if (stage.format === 'pdf') reject('PDF_RENDERER_UNAVAILABLE', 'No verified bounded PDF renderer is configured.');
  if (stage.status !== 'needs_vision' || stage.format !== 'image') reject('VALIDATION', 'OCR expects a staged image.');
  if (typeof adapter.extract !== 'function') reject('PROVENANCE_UNVERIFIED', 'Invalid OCR adapter.');
  const route = routeContract(adapter.contract), controller = new AbortController();
  let timer, abort;
  try {
    const stop = new Promise((_, rejectPromise) => {
      abort = () => { controller.abort(); rejectPromise(Object.assign(new Error('Extraction cancelled.'), { code: 'CANCELLED' })); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { controller.abort(); rejectPromise(Object.assign(new Error('Extraction timed out.'), { code: 'EXTRACTION_TIMEOUT' })); }, LIMITS.extractionMs);
      if (signal?.aborted) abort();
    });
    if (signal?.aborted) return await stop;
    // Trusted adapter must isolate decode, bound streaming response bytes and
    // honor cancellation. A Promise timeout cannot terminate arbitrary JS code.
    const work = Promise.resolve().then(() => adapter.extract(freeze(stage), { signal: controller.signal, maxResponseBytes: LIMITS.responseBytes, maxPixels: 20000000, maxPages: LIMITS.pages, sourceTrust: 'untrusted_data_not_instructions' }));
    const response = await Promise.race([work, stop]);
    return freeze({ status: 'candidates', sourceDigest: stage.source.digest, stageDigest: stage.stageDigest, candidates: validateExtraction(stage, response, route) });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function checkCandidates(stage, candidates) {
  candidates = snapshot(candidates, LIMITS.responseBytes);
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > LIMITS.candidates) reject('VALIDATION', 'No bounded candidates to review.');
  const ids = new Set();
  for (const c of candidates) {
    fields(c, ['id', 'kind', 'state', 'sourceDigest', 'stageDigest', 'fields', 'provenance', 'uncertainty']);
    const { id, ...body } = c;
    if (id !== hash(body) || c.stageDigest !== stage.stageDigest || c.sourceDigest !== stage.source.digest || ids.has(id)) reject('SOURCE_REFERENCE', 'Candidate is stale, duplicated or belongs to another source.');
    if (!Array.isArray(c.fields) || !c.fields.length || c.fields.length > LIMITS.fields || !c.provenance) reject('VALIDATION', 'Invalid candidate fields/provenance.');
    let reconstructed;
    if (c.provenance.method === 'deterministic_parser') {
      reconstructed = createCandidatesChecked(stage, [{ kind: c.kind, fields: c.fields.map(f => ({ name: f.name, elementId: f.sourceRef?.elementId })) }])[0];
    } else if (c.provenance.method === 'ocr') {
      const { method, ...provenance } = c.provenance;
      reconstructed = validateExtractionChecked(stage, {
        sourceDigest: stage.source.digest, stageDigest: stage.stageDigest, provenance, toolCalls: [],
        candidates: [{ kind: c.kind, fields: c.fields.map(f => ({ name: f.name, raw: f.raw, uncertainty: f.uncertainty?.[0], confidence: f.confidence, locator: f.sourceRef?.locator })) }],
      }, { engine: provenance.engine, provider: provenance.provider, recipient: provenance.recipient, revision: provenance.revision, noFallback: true, toolFree: true, boundedResponse: true })[0];
    } else reject('VALIDATION', 'Unsupported candidate provenance.');
    if (hash(c) !== hash(reconstructed)) reject('SOURCE_REFERENCE', 'Candidate values/references differ from their original extraction.');
    ids.add(id);
  }
  return candidates;
}
function createReviewReceipt(stage, candidates, review) {
  stage = checkStage(stage); candidates = checkCandidates(stage, candidates); review = snapshot(review, 8192);
  fields(review, ['reviewer', 'reviewedAt', 'acknowledgedUncertainty', 'decision']);
  bounded(review.reviewer, 200, 'reviewer');
  // Do not manufacture a clock or user identity in this pure helper.
  const { instant } = require('../farm/validation'); instant(review.reviewedAt);
  if (review.decision !== 'reviewed_for_staging' || review.acknowledgedUncertainty !== true) reject('REVIEW_REQUIRED', 'Explicit uncertainty acknowledgement and staged-review decision are required.');
  const body = { version: VERSION, sourceDigest: stage.source.digest, stageDigest: stage.stageDigest, candidatesDigest: hash(candidates), candidateIds: candidates.map(c => c.id), ...review, ledgerWriteAuthorized: false };
  return freeze({ ...body, receiptDigest: hash(body) });
}
function verifyReviewReceipt(stage, candidates, receipt) {
  receipt = snapshot(receipt, LIMITS.responseBytes);
  const expected = createReviewReceipt(stage, candidates, { reviewer: receipt.reviewer, reviewedAt: receipt.reviewedAt, acknowledgedUncertainty: receipt.acknowledgedUncertainty, decision: receipt.decision });
  if (hash(expected) !== hash(receipt)) reject('REVIEW_MISMATCH', 'Receipt does not match the original source, candidates or review.');
  return true;
}
module.exports = { LIMITS, capabilities, parseBytes, parseSelected, createCandidates, validateExtraction, extractWithAdapter, createReviewReceipt, verifyReviewReceipt };
