'use strict';

// Validate every feed and artifact before a publisher performs its first write.
//
//   node scripts/preflight-release.js [root] [version]                       # release/, the latest channel
//   node scripts/preflight-release.js --config electron-builder.developer.js  # release-developers/, developers
//   node scripts/preflight-release.js release-developers 0.24.7 --channel developers
//
// The feeds looked for are the channel's own (latest*.yml, developers*.yml), so
// a directory holding the other edition's build has no feeds as far as this
// channel is concerned and is refused rather than published under its name.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const pkg = require('../package.json');
const { DEFAULT_CHANNEL, OSES, feedName, fromArgs } = require('./release-channel');

async function preflight(root, version = pkg.version, channel = DEFAULT_CHANNEL) {
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
  for (const name of OSES.map(os => feedName(channel, os))) {
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
  if (!feeds.length) throw new Error(`no release feeds found for the ${channel} channel`);
  return { channel, feeds, artifacts };
}

if (require.main === module) {
  let target;
  try {
    target = fromArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`preflight: ${error.message}`);
    process.exit(1);
  }
  preflight(target.rest[0] || target.dir, target.rest[1] || pkg.version, target.channel)
    .then(result => console.log(`preflight: ${result.channel} channel, ${result.feeds.length} feeds, ${result.artifacts} artifacts verified`))
    .catch(error => { console.error(`preflight: ${error.message}`); process.exitCode = 1; });
}
module.exports = { preflight };
