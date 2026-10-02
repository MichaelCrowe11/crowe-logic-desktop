'use strict';

// One place for what a release channel is called and where it lives.
//
// The full edition publishes on the `latest` channel and keeps exactly the keys
// it has always had: installers under desktop/<version>/, feeds under
// desktop/channel/<os>/latest*.yml, the download page at /. Crowe Logic for
// Developers publishes on `developers`, beside it, under a prefix of its own:
//
//   desktop/developers/<version>/<artifact>              installers, blockmaps, SHA256SUMS
//   desktop/developers/channel/<os>/developers-<os>.yml  the update feeds
//   /developers                                          the download page
//
// Feeds included, so that nothing the developer publish writes can land on a
// key the full edition serves, and nothing the full edition writes can be read
// as a developer release. electron-updater names the feed after the channel
// (developers-mac.yml; developers.yml on Windows, where the suffix is empty) and
// resolves every file the feed names relative to the feed's own directory, so
// the publish url in electron-builder.developer.js ends in that channel
// directory. The publishers, the preflight, the verifier and the developer
// config all take the layout from here; the releases worker ships on its own
// and spells the same layout out in deploy/releases-worker/src/index.js, and
// scripts/test-releases-worker.js holds the two to each other.

const path = require('path');

const DEFAULT_CHANNEL = 'latest';
const OSES = ['win', 'mac', 'linux'];

// A channel name becomes a bucket prefix and a url path, so it is held to a
// character set that cannot escape either. "channel" is refused because it is
// the directory the feeds sit in.
function assertChannel(channel) {
  if (typeof channel !== 'string' || !/^[a-z][a-z0-9-]*$/.test(channel) || channel === 'channel') {
    throw new Error(`release channel must be lowercase letters, digits and hyphens: ${JSON.stringify(channel)}`);
  }
  return channel;
}

// The feed electron-builder writes and electron-updater asks for.
function feedName(channel, os) {
  assertChannel(channel);
  if (!OSES.includes(os)) throw new Error(`unknown os: ${os}`);
  return os === 'win' ? `${channel}.yml` : `${channel}-${os}.yml`;
}

// Bucket prefix everything on the channel is stored under.
function prefix(channel) {
  return assertChannel(channel) === DEFAULT_CHANNEL ? 'desktop' : `desktop/${channel}`;
}

// Where electron-builder leaves the build: release/ for the full edition, and
// release-<channel>/ for an edition, which is what electron-builder.developer.js
// sets so a developer artifact is never swept into the full edition's publish.
function outputDir(channel) {
  return assertChannel(channel) === DEFAULT_CHANNEL ? 'release' : `release-${channel}`;
}

// The download page the releases worker renders for the channel.
function pagePath(channel) {
  return assertChannel(channel) === DEFAULT_CHANNEL ? '/' : `/${channel}`;
}

// The feed's key, an installer's key, and the key the updater asks for an
// installer by (the feed's directory plus the name the feed gives), which the
// worker maps back onto the installer's key.
function feedKey(channel, os) { return `${prefix(channel)}/channel/${os}/${feedName(channel, os)}`; }
function artifactKey(channel, version, name) { return `${prefix(channel)}/${version}/${name}`; }
function updateKey(channel, os, name) { return `${prefix(channel)}/channel/${os}/${name}`; }

// Reads `--channel <name>` (or `--channel=<name>`) and `--config <electron-builder
// config>` out of an argument list and hands back the rest untouched. --config
// takes the channel from publish[].channel and the output directory from
// directories.output, so a publisher can be run with exactly the config the
// build ran with, the same way scripts/staple-dmg.js is. `dir` is the channel's
// output directory whether or not a config named one.
function fromArgs(argv) {
  const rest = [];
  let channel = DEFAULT_CHANNEL;
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--channel' || arg === '--config') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === '--channel') { channel = assertChannel(value); continue; }
      const cfg = require(path.resolve(value));
      const pub = [].concat(cfg.publish || []).find((p) => p && p.channel);
      channel = assertChannel(pub ? pub.channel : DEFAULT_CHANNEL);
      if (cfg.directories && cfg.directories.output) dir = cfg.directories.output;
    } else if (arg.startsWith('--channel=')) {
      channel = assertChannel(arg.slice('--channel='.length));
    } else {
      rest.push(arg);
    }
  }
  return { channel, dir: dir || outputDir(channel), rest };
}

// Exported before the command-line block below runs: --config requires
// electron-builder.developer.js, which requires this module back for its
// prefix and output directory, and would otherwise see an empty export.
module.exports = { DEFAULT_CHANNEL, OSES, assertChannel, feedName, prefix, outputDir, pagePath, feedKey, artifactKey, updateKey, fromArgs };

// `node scripts/release-channel.js --shell [args]` prints the layout as shell
// assignments for the bash publishers to eval: channel, prefix, page, dir (the
// channel's default output directory), root (the first positional argument, or
// empty) and feed_<os> for each os. Every value is single-quoted.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--shell');
  if (at === -1) {
    console.error('usage: node scripts/release-channel.js --shell [root] [--channel <name> | --config <file>]');
    process.exit(2);
  }
  argv.splice(at, 1);
  try {
    const { channel, dir, rest } = fromArgs(argv);
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const lines = [
      `channel=${q(channel)}`,
      `root=${q(rest[0] || '')}`,
      `dir=${q(dir)}`,
      `prefix=${q(prefix(channel))}`,
      `page=${q(pagePath(channel))}`,
      ...OSES.map((os) => `feed_${os}=${q(feedName(channel, os))}`),
    ];
    console.log(lines.join('\n'));
  } catch (error) {
    console.error(`release-channel: ${error.message}`);
    process.exit(1);
  }
}
