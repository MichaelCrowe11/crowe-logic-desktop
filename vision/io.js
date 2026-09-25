'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fault } = require('./validation');
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
function directory(dir) {
  if (!path.isAbsolute(dir) || fs.realpathSync(dir) !== path.resolve(dir)) throw fault('UNSAFE_PATH', 'Select a real directory without symbolic-link aliases.');
  return fs.lstatSync(dir, { bigint: true });
}
function readBounded(filename, max, optional = false) {
  directory(path.dirname(filename));
  let before;
  try { before = fs.lstatSync(filename, { bigint: true }); }
  catch (e) { if (optional && e.code === 'ENOENT') return { bytes: Buffer.from('[]'), stamp: null }; throw e; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(max)) throw fault('UNSAFE_FILE', 'Select a regular, unaliased file within the supported byte limit.');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before)) throw fault('SOURCE_CHANGED', 'The selected file changed.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    if (count !== Number(before.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before) || stamp(fs.lstatSync(filename, { bigint: true })) !== stamp(before)) throw fault('SOURCE_CHANGED', 'The selected file changed while reading.');
    return { bytes: bytes.subarray(0, count), stamp: stamp(before) };
  } finally { fs.closeSync(fd); }
}
module.exports = { readBounded, directory, stamp };
