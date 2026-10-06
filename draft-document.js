const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const MAX_BYTES = 1024 * 1024;

function decode(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error("Draft exceeds 1 MiB.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function openDocument(filename) {
  if (!path.isAbsolute(filename)) throw new Error("Draft path must be absolute.");
  const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(filename, flags);
  let original;
  let stat;
  try {
    stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Draft must be a regular file with one link.");
    if (stat.size > MAX_BYTES) throw new Error("Draft exceeds 1 MiB.");
    original = fs.readFileSync(fd);
    decode(original);
  } finally { fs.closeSync(fd); }
  let saved = original;
  const newline = original.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
  function encode(text) {
    if (typeof text !== "string") throw new Error("Draft must be text.");
    const bytes = Buffer.from(newline === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text, "utf8");
    if (bytes.length > MAX_BYTES) throw new Error("Draft exceeds 1 MiB.");
    return bytes;
  }
  return {
    name: path.basename(filename),
    text: decode(original),
    changed(text) {
      // An oversized edit must still be discardable through the close dialog.
      try { return !encode(text).equals(saved); } catch { return true; }
    },
    save(text) {
      const bytes = encode(text);
      const current = fs.openSync(filename, flags);
      try {
        const now = fs.fstatSync(current);
        if (!now.isFile() || now.dev !== stat.dev || now.ino !== stat.ino || now.nlink !== 1 || now.size > MAX_BYTES || !fs.readFileSync(current).equals(saved)) {
          throw new Error("The draft changed outside this window. Your edit is still here; copy it before closing.");
        }
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(current, bytes, offset, bytes.length - offset, offset);
          if (!count) throw new Error("Could not finish writing the draft.");
          offset += count;
        }
        fs.ftruncateSync(current, bytes.length);
        fs.fsyncSync(current);
        saved = bytes;
      } finally { fs.closeSync(current); }
    },
  };
}

module.exports = { openDocument, MAX_BYTES };
