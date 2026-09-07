'use strict';

// Validate every feed and artifact before a publisher performs its first write.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const pkg = require('../package.json');

async function preflight(root, version = pkg.version) {
  if (version !== pkg.version) throw new Error(`release version ${version} differs from package ${pkg.version}`);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in release directory: ${file}`);
      if (entry.isDirectory() && !entry.name.endsWith('.app')) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  walk(path.resolve(root));
  function resolve(name, optional = false) {
    const matches = files.filter(f => [name, name.replace(/ /g, '.')].includes(path.basename(f)));
    if (matches.length > 1) throw new Error(`ambiguous release file: ${name}`);
    if (!matches.length && !optional) throw new Error(`missing release file: ${name}`);
    return matches[0];
  }
  const feeds = [];
  let artifacts = 0;
  for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    const file = resolve(name, true);
    if (!file) continue;
    const feed = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!feed || feed.version !== version) throw new Error(`${name}: expected version ${version}`);
    if (!Array.isArray(feed.files) || !feed.files.length) throw new Error(`${name}: empty files list`);
    const urls = new Set();
    for (const item of feed.files) {
      const url = item && item.url;
      // Publishers use basenames as object keys; reject paths and shell/glob syntax.
      if (typeof url !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(url) || !url.includes(version)) {
        throw new Error(`${name}: unsafe or stale artifact name`);
      }
      if (urls.has(url)) throw new Error(`${name}: duplicate artifact ${url}`);
      urls.add(url);
      const artifact = resolve(url);
      if (!Number.isSafeInteger(item.size) || item.size <= 0 || fs.statSync(artifact).size !== item.size) {
        throw new Error(`${url}: size mismatch`);
      }
      const hash = crypto.createHash('sha512');
      for await (const chunk of fs.createReadStream(artifact)) hash.update(chunk);
      if (hash.digest('base64') !== item.sha512) throw new Error(`${url}: sha512 mismatch`);
      if (/\.(dmg|zip|exe)$/.test(url)) {
        const blockmap = resolve(`${url}.blockmap`);
        if (!fs.statSync(blockmap).size) throw new Error(`${url}: empty blockmap`);
      }
      artifacts++;
    }
    if (feed.path && !urls.has(feed.path)) throw new Error(`${name}: legacy path not in files`);
    if (feed.sha512 && feed.path && feed.sha512 !== feed.files.find(f => f.url === feed.path).sha512) {
      throw new Error(`${name}: legacy checksum mismatch`);
    }
    feeds.push(name);
  }
  if (!feeds.length) throw new Error('no release feeds found');
  return { feeds, artifacts };
}

if (require.main === module) {
  preflight(process.argv[2] || 'release', process.argv[3] || pkg.version)
    .then(result => console.log(`preflight: ${result.feeds.length} feeds, ${result.artifacts} artifacts verified`))
    .catch(error => { console.error(`preflight: ${error.message}`); process.exitCode = 1; });
}
module.exports = { preflight };
