'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { readBounded } = require('./io');
const { fault, hash } = require('./validation');
const LIMITS = Object.freeze({ sourceBytes: 10 * 1024 * 1024, pixels: 20000000, sourceSide: 20000, side: 1280, outputBytes: 4 * 1024 * 1024, decodeMs: 8000 });
function dimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) throw fault('IMAGE_FORMAT', 'Select a complete PNG or JPEG image.');
  let width, height, mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) throw fault('IMAGE_FORMAT', 'Invalid PNG header.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mime = 'image/png';
    let pos = 8, ended = false;
    while (pos + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(pos), type = bytes.toString('ascii', pos + 4, pos + 8);
      if (length > bytes.length - pos - 12 || type === 'acTL') throw fault('IMAGE_FORMAT', 'Truncated or animated PNG is unsupported.');
      pos += length + 12;
      if (type === 'IEND') { ended = true; break; }
    }
    if (!ended || pos !== bytes.length) throw fault('IMAGE_FORMAT', 'PNG contains incomplete or trailing data.');
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    let pos = 2;
    while (pos < bytes.length - 2) {
      if (bytes[pos++] !== 255) break;
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 0xda || marker === 0xd9) break;
      if (pos + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(pos);
      if (size < 2 || pos + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8 || bytes[pos + 2] !== 8) break;
        height = bytes.readUInt16BE(pos + 3); width = bytes.readUInt16BE(pos + 5); mime = 'image/jpeg'; break;
      }
      pos += size;
    }
  }
  if (!mime || !width || !height) throw fault('IMAGE_FORMAT', 'Only standard PNG and 8-bit JPEG photos are supported.');
  if (width > LIMITS.sourceSide || height > LIMITS.sourceSide || width * height > LIMITS.pixels) throw fault('IMAGE_DIMENSIONS', 'Photo exceeds 20 megapixels or the supported source dimensions.');
  return { width, height, mime };
}
async function normalizeSelected(filename, decode, signal) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !/\.(png|jpe?g)$/i.test(filename)) throw fault('IMAGE_FORMAT', 'Select a native PNG or JPEG file.');
  const input = readBounded(filename, LIMITS.sourceBytes).bytes;
  const info = dimensions(input);
  if (signal?.aborted) throw fault('CANCELLED', 'Inspection cancelled.');
  const bytes = await decode(input, info, signal);
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.outputBytes) throw fault('IMAGE_LIMIT', 'Normalized photo exceeds 4 MiB.');
  const output = dimensions(bytes);
  if (output.mime !== 'image/png' || Math.max(output.width, output.height) > LIMITS.side) throw fault('IMAGE_LIMIT', 'Decoder did not produce a bounded normalized PNG.');
  return { bytes, mime: output.mime, width: output.width, height: output.height, digest: hash(bytes) };
}
// A separate Chromium sandbox process decodes/reencodes. No preload, Node,
// persistent partition, network, popup, downloads, camera or file navigation.
// Header preflight bounds pixel allocation; process lifetime is independently
// bounded. This is not a claim of an OS-enforced RSS limit.
function createDecoder({ BrowserWindow, session }) {
  return async (input, info, signal) => {
    const partition = session.fromPartition(`vision-decode-${crypto.randomUUID()}`, { cache: false });
    partition.setPermissionRequestHandler((_wc, _permission, answer) => answer(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, answer) => answer({ cancel: !details.url.startsWith('data:') }));
    partition.on('will-download', event => event.preventDefault());
    const win = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webgl: false, images: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    let timer, abort;
    try {
      const stopped = new Promise((_, reject) => {
        abort = () => reject(fault('CANCELLED', 'Inspection cancelled.'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(fault('DECODE_TIMEOUT', 'Image decoding timed out.')), LIMITS.decodeMs);
        if (signal?.aborted) abort();
      });
      const work = (async () => {
        await win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:; script-src %27none%27">');
        return win.webContents.executeJavaScript(`(async () => {
          const raw = atob(${JSON.stringify(input.toString('base64'))});
          const data = Uint8Array.from(raw, c => c.charCodeAt(0));
          const image = await createImageBitmap(new Blob([data], {type:${JSON.stringify(info.mime)}}));
          if (!image.width || !image.height || image.width * image.height > ${LIMITS.pixels} || Math.max(image.width,image.height)>${LIMITS.sourceSide}) { image.close(); throw Error('Image dimensions'); }
          const scale = Math.min(1, ${LIMITS.side} / Math.max(image.width,image.height));
          const canvas = document.createElement('canvas'); canvas.width=Math.max(1,Math.round(image.width*scale)); canvas.height=Math.max(1,Math.round(image.height*scale));
          const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0,canvas.width,canvas.height); image.close();
          const output=canvas.toDataURL('image/png'); if(output.length > ${Math.ceil(LIMITS.outputBytes * 4 / 3) + 40}) throw Error('Image output limit'); return output;
        })()`);
      })();
      const result = await Promise.race([work, stopped]);
      if (typeof result !== 'string' || !result.startsWith('data:image/png;base64,')) throw fault('IMAGE_FORMAT', 'Photo decoding failed.');
      return Buffer.from(result.slice(22), 'base64');
    } catch (error) {
      if (['CANCELLED', 'DECODE_TIMEOUT'].includes(error.code)) throw error;
      throw fault('IMAGE_DECODE', 'The image could not be safely decoded.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (!win.isDestroyed()) win.destroy();
    }
  };
}
module.exports = { LIMITS, dimensions, normalizeSelected, createDecoder };
