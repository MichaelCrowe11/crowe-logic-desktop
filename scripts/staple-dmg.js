'use strict';

// afterSign notarizes the .app, which is what Gatekeeper checks at launch. The
// DMG we actually distribute is built afterwards and carries no ticket of its
// own, so opening it without network access still warns. Apple's guidance is to
// staple the artifact you ship, so the DMG needs its own submission.
//
// This runs after electron-builder rather than as an afterAllArtifactBuild
// hook, because latest-mac.yml is written by the publish manager after that
// hook fires and would overwrite anything the hook corrected. Stapling rewrites
// the DMG, so the recorded sha512, size and blockmap all go stale and are
// regenerated here with electron-builder's own blockmap builder, which produces
// exactly the values the build would have recorded.
//
// Usage: node scripts/staple-dmg.js [outputDir]                          (default: release, feed latest-mac.yml)
//        node scripts/staple-dmg.js --config electron-builder.developer.js
//
// The feed's name follows the update channel: electron-builder writes
// latest-mac.yml for the default build and developers-mac.yml for the developer
// edition, which also lands in release-developers/. Rather than a second pair
// of names here to keep in step, --config reads the same electron-builder
// config the build ran with and takes directories.output and publish[].channel
// from it. A positional directory still wins over the config's, as before.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

function run(args) {
  execFileSync('xcrun', args, { stdio: 'inherit' });
}

// latest-mac.yml is generated, so its shape is predictable: a `files:` list of
// `- url:` / `sha512:` / `size:` entries. Patch the one entry by name rather
// than taking on a YAML dependency.
function patchUpdateInfo(ymlPath, dmgName, sha512, size) {
  if (!fs.existsSync(ymlPath)) return false;
  const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === `- url: ${dmgName}`);
  if (at === -1) return false;

  let patched = 0;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*- url:/.test(lines[i])) break;
    if (/^\s+sha512:/.test(lines[i])) {
      lines[i] = lines[i].replace(/sha512:.*/, `sha512: ${sha512}`);
      patched++;
    } else if (/^\s+size:/.test(lines[i])) {
      lines[i] = lines[i].replace(/size:.*/, `size: ${size}`);
      patched++;
    }
  }
  if (patched !== 2) {
    throw new Error(`staple-dmg: could not patch ${dmgName} in ${path.basename(ymlPath)}`);
  }
  fs.writeFileSync(ymlPath, lines.join('\n'));
  return true;
}

// Where the artifacts are and what the feed is called, from the arguments and
// the builder config they name. Defaults are the default edition's.
function target(argv) {
  const args = argv.slice(2);
  let dir = 'release';
  let channel = 'latest';
  const at = args.indexOf('--config');
  if (at !== -1) {
    if (!args[at + 1]) throw new Error('staple-dmg: --config needs a path');
    const cfg = require(path.resolve(args[at + 1]));
    if (cfg.directories && cfg.directories.output) dir = cfg.directories.output;
    const pub = [].concat(cfg.publish || []).find((p) => p && p.channel);
    if (pub) channel = pub.channel;
    args.splice(at, 2);
  }
  if (args[0]) dir = args[0];
  return { dir: path.resolve(dir), feed: `${channel}-mac.yml` };
}

async function main() {
  const { dir, feed } = target(process.argv);

  if (process.platform !== 'darwin') return;
  if (process.env.CROWE_SKIP_NOTARIZE === '1') {
    console.log('staple-dmg: skipped (CROWE_SKIP_NOTARIZE=1)');
    return;
  }
  if (!fs.existsSync(dir)) {
    console.log(`staple-dmg: no ${dir}, nothing to do`);
    return;
  }

  const dmgs = fs.readdirSync(dir).filter((f) => f.endsWith('.dmg'));
  if (dmgs.length === 0) {
    console.log('staple-dmg: no dmg found, nothing to do');
    return;
  }

  const profile = process.env.CROWE_NOTARY_PROFILE || 'crowe-notary';
  // Same escape hatch as build/notarize.js: the App Store Connect API key on
  // disk works from a session whose login keychain (and profile) is locked.
  const { CROWE_NOTARY_KEY: key, CROWE_NOTARY_KEY_ID: keyId, CROWE_NOTARY_ISSUER: issuer } = process.env;
  const auth = key && keyId && issuer ? ['--key', key, '--key-id', keyId, '--issuer', issuer] : ['--keychain-profile', profile];

  for (const name of dmgs) {
    const dmg = path.join(dir, name);
    // If a ticket is already attached the artifact is final, and re-submitting
    // would only invalidate the metadata that was just reconciled to it.
    try {
      execFileSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'ignore' });
      console.log(`staple-dmg: ${name} already stapled`);
      continue;
    } catch {
      // no ticket yet, carry on
    }

    console.log(`staple-dmg: submitting ${name} (profile: ${profile})`);
    run(['notarytool', 'submit', dmg, ...auth, '--wait']);
    run(['stapler', 'staple', dmg]);

    const info = await buildBlockMap(dmg, 'gzip', `${dmg}.blockmap`);
    const yml = path.join(dir, feed);
    if (!patchUpdateInfo(yml, name, info.sha512, info.size)) {
      throw new Error(`staple-dmg: ${name} is not listed in ${feed}`);
    }
    console.log(`staple-dmg: stapled ${name}, refreshed ${feed} and blockmap`);
  }
}

module.exports = { target, patchUpdateInfo };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
