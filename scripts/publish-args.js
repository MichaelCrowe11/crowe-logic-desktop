'use strict';

// Publisher arguments are stricter than diagnostic release-channel probes.
// Explicit paths are relative to the caller; default build output is relative
// to this repository. Resolve once, before either shell changes directory.
const path = require('path');
const pkg = require('../package.json');
const channels = require('./release-channel');
const matrices = require('./release-matrix');

function resolvePublishArgs(argv, { cwd = process.cwd(), repo = path.resolve(__dirname, '..'), env = process.env } = {}) {
  const selection = [];
  const remaining = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice(9);
      if (!value || value.startsWith('--')) throw new Error('--config needs a value');
      selection.push('--config', path.resolve(cwd, value));
    } else if (arg === '--channel' || arg.startsWith('--channel=')) {
      const value = arg === '--channel' ? argv[++i] : arg.slice(10);
      if (!value || value.startsWith('--')) throw new Error('--channel needs a value');
      selection.push('--channel', value);
    } else remaining.push(arg);
  }
  const options = matrices.fromArgs(['--strict', ...remaining]);
  if (options.rest.length > 1 || options.rest.some(arg => arg.startsWith('-') || !arg)) throw new Error('unexpected publisher arguments; supply one root and an explicit --matrix');
  // Reject malformed CLI input before loading executable builder configs or
  // looking up the CI version. Configs must remain trusted local build code.
  for (let i = 0; i < selection.length; i += 2) if (selection[i] === '--channel') channels.assertChannel(selection[i + 1]);
  const target = channels.fromArgs(selection);
  const root = options.rest.length ? path.resolve(cwd, options.rest[0]) : path.resolve(repo, target.dir);
  const version = (env.GITHUB_REF_NAME || pkg.version).replace(/^v/, '');
  if (version !== pkg.version) throw new Error(`release version ${version} differs from package ${pkg.version}`);
  // Include the effective channel even for the default, so no downstream
  // process can silently choose another edition. Preserve configs as well.
  const validationArgs = [...selection, '--channel', target.channel, '--strict', '--matrix', options.matrix];
  return { root, version, channel: target.channel, matrix: options.matrix, validationArgs };
}

function shellArgs(target) {
  const q = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return [
    `root=${q(target.root)}`,
    `version=${q(target.version)}`,
    `channel=${q(target.channel)}`,
    `prefix=${q(channels.prefix(target.channel))}`,
    ...channels.OSES.map(os => `feed_${os}=${q(channels.feedName(target.channel, os))}`),
    `validation_args=(${target.validationArgs.map(q).join(' ')})`,
  ].join('\n');
}

module.exports = { resolvePublishArgs, shellArgs };
if (require.main === module) {
  try { console.log(shellArgs(resolvePublishArgs(process.argv.slice(2)))); }
  catch (error) { console.error(`publish: ${error.message}`); process.exitCode = 1; }
}
