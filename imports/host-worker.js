'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createImportStore } = require('./host-store');
const store = createImportStore(workerData.userData);
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!['choose', 'list', 'open', 'preview', 'revise', 'review', 'promotion', 'sharedPrepare', 'sharedIntent'].includes(method)) throw Object.assign(new Error('Unsupported archive operation.'), { code: 'VALIDATION' });
    parentPort.postMessage({ id, ok: true, data: store[method](...args) });
  } catch (error) {
    const known = /^(VALIDATION|SOURCE_|UNSAFE_|STORE_|ZIP_|XML_|OFFICE_|ACTIVE_|CONTENT_|ENCODING|CSV_|PDF_|IMAGE_|PARSER_|REVIEW_|REVISION_|DUPLICATE_|WRITE_OUTCOME_UNKNOWN)/.test(error.code || '');
    parentPort.postMessage({ id, ok: false, error: { code: known ? error.code : 'IMPORT_FAILED', message: known ? error.message : 'Local import could not complete safely. No automatic retry was made.' } });
  }
});
