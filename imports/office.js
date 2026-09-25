'use strict';
// No filesystem extraction, macros, relationship fetching, formula evaluation,
// office automation, or Python runtime. Unsupported OOXML features stay warnings.
const zlib = require('node:zlib');
const path = require('node:path').posix;
const { LIMITS: L, reject, utf8, element } = require('./safety');
const NS = { w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', rel: 'http://schemas.openxmlformats.org/package/2006/relationships' };
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function unzip(bytes) {
  const bad = () => reject('ZIP_FORMAT', 'Unsupported, ambiguous, or malformed ZIP archive.');
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  if (end < 0 || end < bytes.length - 65557) bad();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || offset + size !== end) bad();
  if (count > L.entries) reject('ZIP_LIMIT', 'Too many ZIP entries.');
  let pos = offset, expanded = 0;
  const entries = new Map(), ranges = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) bad();
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10), crc = bytes.readUInt32LE(pos + 16), packed = bytes.readUInt32LE(pos + 20), length = bytes.readUInt32LE(pos + 24), namesize = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32), local = bytes.readUInt32LE(pos + 42);
    const unixMode = bytes.readUInt32LE(pos + 38) >>> 16;
    if (pos + 46 + namesize + extra + comment > end || flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(pos + 34) || (unixMode & 0xf000) === 0xa000) bad();
    const name = utf8(bytes.subarray(pos + 46, pos + 46 + namesize));
    if (!name || name.length > 300 || /[^\x20-\x7e]|[\\:]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.') || entries.has(name.toLowerCase())) bad();
    expanded += length;
    if (length > L.entryBytes || expanded > L.expandedBytes || length > Math.max(1, packed) * L.ratio) reject('ZIP_LIMIT', 'ZIP decompression exceeds limits.');
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) bad();
    const ln = bytes.readUInt16LE(local + 26), le = bytes.readUInt16LE(local + 28), start = local + 30 + ln + le, stop = start + packed;
    if (stop > offset || ln !== namesize || !bytes.subarray(local + 30, local + 30 + ln).equals(bytes.subarray(pos + 46, pos + 46 + namesize))) bad();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== packed || bytes.readUInt32LE(local + 22) !== length)) bad();
    if (ranges.some(([a, b]) => local < b && stop > a)) bad();
    ranges.push([local, stop]);
    let data;
    try { data = method === 0 ? Buffer.from(bytes.subarray(start, stop)) : zlib.inflateRawSync(bytes.subarray(start, stop), { maxOutputLength: Math.min(L.entryBytes, length + 1) }); }
    catch { reject('ZIP_LIMIT', 'Invalid or oversized compressed ZIP entry.'); }
    if (data.length !== length || crc32(data) !== crc) bad();
    entries.set(name.toLowerCase(), { name, data });
    pos += 46 + namesize + extra + comment;
  }
  if (pos !== end) bad();
  return entries;
}
function xml(bytes) {
  const text = utf8(bytes).replace(/^﻿/, '');
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text) || /<\?xml[^?]*encoding\s*=\s*['"](?!utf-8['"])/i.test(text)) reject('XML_UNSAFE', 'DTD, entities and non-UTF-8 XML are unsupported.');
  let sax;
  try { sax = require('sax'); } catch { reject('PARSER_UNAVAILABLE', 'The installed SAX XML parser is unavailable.'); }
  const parser = sax.parser(true, { xmlns: true, strictEntities: true, trim: false, normalize: false });
  let root, nodes = 0, chars = 0;
  const stack = [];
  parser.onerror = () => reject('XML_FORMAT', 'Malformed document XML.');
  parser.ondoctype = () => reject('XML_UNSAFE', 'DTD is unsupported.');
  parser.onopentag = tag => {
    if (++nodes > L.xmlNodes || stack.length >= L.xmlDepth || Object.keys(tag.attributes).length > 64) reject('XML_LIMIT', 'XML structure exceeds supported limits.');
    const node = { name: tag.local, uri: tag.uri, attrs: tag.attributes, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node); else if (root) reject('XML_FORMAT', 'Multiple XML roots.'); else root = node;
    stack.push(node);
  };
  parser.onclosetag = () => stack.pop();
  parser.ontext = parser.oncdata = value => {
    chars += value.length;
    if (chars > L.textChars) reject('XML_LIMIT', 'XML text exceeds supported limits.');
    if (stack.length) stack[stack.length - 1].children.push(value);
    else if (value.trim()) reject('XML_FORMAT', 'Text outside XML root.');
  };
  try { parser.write(text).close(); } catch (e) { if (e.code) throw e; reject('XML_FORMAT', 'Malformed document XML.'); }
  if (!root || stack.length) reject('XML_FORMAT', 'Incomplete document XML.');
  return root;
}
const attr = (node, name, uri = '') => Object.values(node.attrs).find(a => a.local === name && a.uri === uri)?.value;
const children = (node, name, uri) => node.children.filter(n => typeof n !== 'string' && n.name === name && n.uri === uri);
function all(node, name, uri) { const out = []; function visit(n) { if (typeof n === 'string') return; if (n.name === name && n.uri === uri) out.push(n); n.children.forEach(visit); } visit(node); return out; }
const textOf = node => node.children.map(n => typeof n === 'string' ? n : textOf(n)).join('');
// Phonetic guides (rPh) are not part of the stored string value.
const stringOf = node => node.children.filter(n => typeof n !== 'string' && n.uri === NS.s && ['t', 'r'].includes(n.name)).map(n => n.name === 't' ? textOf(n) : children(n, 't', NS.s).map(textOf).join('')).join('');
function readPart(entries, name) { const entry = entries.get(name.toLowerCase()); if (!entry) reject('OFFICE_FORMAT', 'A required document part is missing.'); return xml(entry.data); }
function relationships(entries, part) {
  if (!entries.has(part.toLowerCase())) return [];
  const root = readPart(entries, part), seen = new Set();
  if (root.name !== 'Relationships' || root.uri !== NS.rel) reject('OFFICE_FORMAT', 'Unsupported relationships XML.');
  return children(root, 'Relationship', NS.rel).map(n => {
    const id = attr(n, 'Id'), target = attr(n, 'Target'), type = attr(n, 'Type'), mode = attr(n, 'TargetMode');
    if (!id || !target || !type || seen.has(id)) reject('OFFICE_FORMAT', 'Invalid or duplicate relationship.');
    seen.add(id); return { id, target, type, external: mode === 'External' };
  });
}
function resolvePart(base, target) {
  if (/^[a-z]+:|[\\#?%]/i.test(target)) reject('OFFICE_FORMAT', 'Unsupported part target.');
  const result = target.startsWith('/') ? target.slice(1) : path.join(base, target);
  if (result.startsWith('../') || result.includes('/../')) reject('OFFICE_FORMAT', 'Unsafe part target.');
  return result;
}
function parseOffice(bytes, format) {
  const entries = unzip(bytes), warnings = [], elements = [], sheets = [];
  for (const { name, data } of entries.values()) {
    if (/(vbaproject|vbasignature|activex|macrosheets|embeddings)/i.test(name)) reject('ACTIVE_CONTENT', 'Macro, embedded executable or active content is unsupported.');
    if (name.toLowerCase() === '[content_types].xml' && /macroenabled|vbaproject/i.test(utf8(data))) reject('ACTIVE_CONTENT', 'Macro-enabled documents are unsupported.');
    if (name.toLowerCase().endsWith('.rels')) {
      const links = relationships(entries, name);
      if (links.some(r => /(vbaProject|activeX|oleObject|package|macrosheet)$/i.test(r.type))) reject('ACTIVE_CONTENT', 'Active or embedded package relationships are unsupported.');
      if (links.some(r => r.external)) warnings.push({ code: 'EXTERNAL_LINK_IGNORED', part: name });
    }
  }
  const contentTypes = readPart(entries, '[Content_Types].xml');
  if (contentTypes.name !== 'Types' || contentTypes.uri !== 'http://schemas.openxmlformats.org/package/2006/content-types') reject('OFFICE_FORMAT', 'Invalid OOXML content types.');
  if (format === 'docx') {
    const root = readPart(entries, 'word/document.xml');
    if (root.name !== 'document' || root.uri !== NS.w) reject('OFFICE_FORMAT', 'Unsupported Word document namespace.');
    const body = children(root, 'body', NS.w)[0];
    if (!body) reject('OFFICE_FORMAT', 'Word document body is missing.');
    let table = 0, paragraph = 0;
    const paragraphText = p => {
      let value = '';
      function visit(n) { if (typeof n === 'string') return; if (n.uri === NS.w && ['txbxContent', 'drawing', 'pict', 'object'].includes(n.name)) return; if (n.uri === NS.w && ['t', 'delText'].includes(n.name)) value += textOf(n); else if (n.uri === NS.w && n.name === 'tab') value += '\t'; else if (n.uri === NS.w && ['br', 'cr'].includes(n.name)) value += '\n'; else n.children.forEach(visit); }
      visit(p); return value;
    };
    function visit(n, location = {}) {
      if (typeof n === 'string') return;
      if (n.uri === NS.w && n.name === 'tbl') { const t = ++table; children(n, 'tr', NS.w).forEach((r, ri) => children(r, 'tc', NS.w).forEach((c, ci) => c.children.forEach(v => visit(v, { table: t, row: ri + 1, column: ci + 1 })))); return; }
      if (n.uri === NS.w && n.name === 'p') {
        const uncertainty = [];
        if (all(n, 'delText', NS.w).length || all(n, 'ins', NS.w).length) uncertainty.push('tracked_changes_not_resolved');
        if (all(n, 'fldChar', NS.w).length || all(n, 'fldSimple', NS.w).length || all(n, 'instrText', NS.w).length) uncertainty.push('field_result_not_verified');
        if (['drawing', 'pict', 'object', 'txbxContent'].some(tag => all(n, tag, NS.w).length)) uncertainty.push('embedded_visual_content_not_extracted');
        const raw = paragraphText(n);
        element(elements, { part: 'word/document.xml', paragraph: ++paragraph, page: null, ...location }, raw, raw, 'text', uncertainty); return;
      }
      n.children.forEach(v => visit(v, location));
    }
    visit(body);
    warnings.push({ code: 'PARTIAL_DOCX', detail: 'Body paragraphs/tables only; headers, footers, notes, text boxes, drawing layout and pagination are not reconstructed. Tracked changes and fields require original review.' });
    if ([...entries.keys()].some(n => n.startsWith('word/media/'))) warnings.push({ code: 'IMAGES_NOT_EXTRACTED' });
    return { elements, sheets, warnings, pageCount: null };
  }
  const workbook = readPart(entries, 'xl/workbook.xml');
  if (workbook.name !== 'workbook' || workbook.uri !== NS.s) reject('OFFICE_FORMAT', 'Unsupported spreadsheet namespace.');
  const rels = relationships(entries, 'xl/_rels/workbook.xml.rels');
  const sheetRoot = children(workbook, 'sheets', NS.s)[0];
  if (!sheetRoot) reject('OFFICE_FORMAT', 'Workbook sheets are missing.');
  const list = children(sheetRoot, 'sheet', NS.s);
  if (!list.length || list.length > L.sheets) reject('CONTENT_LIMIT', 'Workbook sheet count exceeds supported limits.');
  const shared = entries.has('xl/sharedstrings.xml') ? all(readPart(entries, 'xl/sharedStrings.xml'), 'si', NS.s).map(stringOf) : [];
  if (shared.length > L.cells || shared.some(s => s.length > L.cellChars)) reject('CONTENT_LIMIT', 'Shared strings exceed supported limits.');
  const sheetNames = new Set(), sheetIds = new Set();
  for (const sheet of list) {
    const name = attr(sheet, 'name'), sheetId = attr(sheet, 'sheetId'), rid = attr(sheet, 'id', NS.r), state = attr(sheet, 'state') || 'visible';
    if (!name || !sheetId || sheetNames.has(name) || sheetIds.has(sheetId)) reject('OFFICE_FORMAT', 'Invalid or duplicate sheet identity.');
    sheetNames.add(name); sheetIds.add(sheetId);
    const rel = rels.find(r => r.id === rid);
    if (!rel || rel.external || rel.type !== NS.r + '/worksheet') reject('OFFICE_FORMAT', 'Unsupported worksheet relationship.');
    const part = resolvePart('xl', rel.target), root = readPart(entries, part);
    if (root.name !== 'worksheet' || root.uri !== NS.s) reject('OFFICE_FORMAT', 'Unsupported worksheet XML.');
    sheets.push({ name, sheetId, part, state, dateSystem: attr(children(workbook, 'workbookPr', NS.s)[0] || { attrs: {} }, 'date1904') || null });
    const data = children(root, 'sheetData', NS.s)[0], addresses = new Set(), rows = new Set();
    for (const row of data ? children(data, 'row', NS.s) : []) {
      const r = attr(row, 'r');
      if (!/^[1-9]\d*$/.test(r || '') || +r > L.rows || rows.has(r)) reject('CONTENT_LIMIT', 'Missing, duplicate or excessive worksheet row.');
      rows.add(r);
      for (const cell of children(row, 'c', NS.s)) {
        const address = attr(cell, 'r'), match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address || '');
        const column = match && [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
        if (!match || match[2] !== r || column > L.columns || addresses.has(address)) reject('CONTENT_LIMIT', 'Invalid, duplicate or excessive worksheet cell.');
        addresses.add(address);
        const type = attr(cell, 't') || 'n', style = attr(cell, 's') || null, values = children(cell, 'v', NS.s), formulas = children(cell, 'f', NS.s);
        if (values.length > 1 || formulas.length > 1) reject('OFFICE_FORMAT', 'Ambiguous cell values.');
        const raw = values.length ? textOf(values[0]) : '', uncertainty = [];
        let value = raw, valueType;
        if (formulas.length) { valueType = 'formula'; uncertainty.push('formula_not_evaluated', 'cached_value_unverified'); }
        else if (type === 's') { if (!/^\d+$/.test(raw) || +raw >= shared.length) reject('OFFICE_FORMAT', 'Invalid shared string index.'); value = shared[+raw]; valueType = 'text'; }
        else if (type === 'inlineStr') { const inline = children(cell, 'is', NS.s); if (inline.length !== 1) reject('OFFICE_FORMAT', 'Missing or ambiguous inline string.'); value = stringOf(inline[0]); valueType = 'text'; }
        else if (type === 'b') { if (!['0', '1'].includes(raw)) reject('OFFICE_FORMAT', 'Invalid explicit boolean cell.'); value = raw === '1'; valueType = 'boolean'; }
        else if (type === 'n') { if (raw && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) reject('OFFICE_FORMAT', 'Invalid numeric cell.'); valueType = raw ? 'number_text' : 'blank'; if (style) uncertainty.push('style_not_interpreted_possible_date'); }
        else if (type === 'd') { valueType = 'date_text'; uncertainty.push('date_not_normalized'); }
        else if (type === 'e') { valueType = 'error'; uncertainty.push('spreadsheet_error'); }
        else if (type === 'str') valueType = 'text';
        else reject('OFFICE_FORMAT', 'Unsupported cell type.');
        element(elements, { part, sheet: name, sheetId, row: +r, column, cell: address, page: null }, raw, value, valueType, uncertainty, { sourceType: type, style, formula: formulas.length ? textOf(formulas[0]) : null, formulaAttributes: formulas.length ? Object.fromEntries(Object.values(formulas[0].attrs).map(a => [a.name, a.value])) : null, hiddenRow: attr(row, 'hidden') || null });
      }
    }
  }
  warnings.push({ code: 'PARTIAL_XLSX', detail: 'Stored cell values only. Formulas, styles/dates, merged cells, comments, charts and hidden-column presentation are not evaluated or reconstructed. Hidden sheets/rows remain included and marked.' });
  return { elements, sheets, warnings, pageCount: null };
}
module.exports = { parseOffice };
