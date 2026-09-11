#!/usr/bin/env node
// crowe - the Crowe Logic agent, headless.
//
//   crowe "rename the timeout constant and update its callers"
//   crowe --tier execute --yes --json "run the test suite and fix what fails"
//   echo "summarize the diff" | crowe -
//
// Same harness the desktop runs. The tier still gates, the approvals still
// expire, the verifier still checks a turn that changed something, and the
// journal still records what happened. What changes is the surface: a terminal
// instead of a window, an exit code instead of a transcript.
//
// Exit codes are the contract for anything scripting this:
//   0  finished
//   1  the gateway call or the run failed
//   2  stopped (SIGINT)
//   3  the verifier failed the turn
//   4  bad usage
//   5  hit the tool-round limit or a spend ceiling before finishing
//   6  the control plane refused the turn

const { runOnce, EXIT } = require("../cli/run");
const { TIERS, APPROVAL_MODES, PLANE_MODES } = require("../cli/config");

const USAGE = `crowe - the Crowe Logic agent, headless

Usage:
  crowe [options] "<request>"
  crowe [options] -            read the request from stdin

Options:
  --tier <t>          plan | readonly | edit | execute   (default: edit)
  --approvals <m>     off | high-risk | strict           (default: high-risk)
  --model <name>      pin a deployment instead of routing
  --role <name>       pin an expert instead of classifying
  --cwd <path>        run against this directory
  --yes               approve prompted actions automatically
  --auto-approve      apply file edits without review
  --no-verifier       skip the independent check of a mutating turn
  --budget <usd>      spend ceiling for this turn (0 = none)
  --token-cap <n>     token ceiling for this turn (0 = none)
  --base-url <url>    gateway base URL
  --token <jwt>       Crowe ID bearer token
  --no-catalog        skip the catalog fetch and route from the bridge table
  --control-plane <m> off | local | remote                (default: off)
  --tenant <id>       tenant to authorize and meter against
  --workspace <id>    workspace within the tenant
  --json              emit one JSON event per line on stdout
  --quiet             print only the final answer
  -h, --help          show this
  -v, --version       show the version

Environment:
  CROWE_TOKEN, CROWE_BASE_URL, CROWE_MODEL, CROWE_AUTONOMY, CROWE_APPROVALS,
  CROWE_HOME (state directory, default ~/.crowe), CROWE_CONFIG (config file)
`;

function parseArgs(argv) {
  const flags = { config: {} };
  const rest = [];
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": flags.help = true; break;
      case "-v": case "--version": flags.version = true; break;
      case "--json": flags.output = "json"; break;
      case "--quiet": flags.output = "quiet"; break;
      case "--yes": flags.yes = true; break;
      case "--auto-approve": flags.config.autoApprove = true; break;
      case "--no-verifier": flags.config.verifier = false; break;
      case "--no-catalog": flags.catalog = false; break;
      case "--control-plane": {
        const v = need(i, a); i++;
        if (!PLANE_MODES.has(v)) throw new Error(`unknown control plane mode "${v}" (off, local, remote)`);
        flags.config.controlPlane = v;
        break;
      }
      case "--tenant": flags.config.tenantId = need(i, a); i++; break;
      case "--workspace": flags.config.workspaceId = need(i, a); i++; break;
      case "--stdin": flags.stdin = true; break;
      case "--cwd": flags.cwd = need(i, a); i++; break;
      case "--role": flags.role = need(i, a); i++; break;
      case "--model": flags.config.model = need(i, a); i++; break;
      case "--token": flags.config.token = need(i, a); i++; break;
      case "--base-url": flags.config.baseUrl = need(i, a); i++; break;
      case "--tier": case "--autonomy": {
        const v = need(i, a); i++;
        if (!TIERS.has(v)) throw new Error(`unknown tier "${v}" (plan, readonly, edit, execute)`);
        flags.config.autonomy = v;
        break;
      }
      case "--approvals": {
        const v = need(i, a); i++;
        if (!APPROVAL_MODES.has(v)) throw new Error(`unknown approval mode "${v}" (off, high-risk, strict)`);
        flags.config.approvals = v;
        break;
      }
      case "--budget": {
        const v = Number(need(i, a)); i++;
        if (!Number.isFinite(v) || v < 0) throw new Error("--budget needs a non-negative number");
        flags.config.turnBudgetUsd = v;
        break;
      }
      case "--token-cap": {
        const v = Number(need(i, a)); i++;
        if (!Number.isFinite(v) || v < 0) throw new Error("--token-cap needs a non-negative number");
        flags.config.turnTokenCap = v;
        break;
      }
      case "-": flags.stdin = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown option "${a}"`);
        rest.push(a);
    }
  }
  return { flags, prompt: rest.join(" ").trim() };
}

function readStdin(stream) {
  return new Promise((resolve) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => { buf += d; });
    stream.on("end", () => resolve(buf.trim()));
    stream.on("error", () => resolve(buf.trim()));
  });
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (e) { process.stderr.write(`crowe: ${e.message}\n\n${USAGE}`); return EXIT.usage; }

  const { flags } = parsed;
  if (flags.help || (!parsed.prompt && !flags.stdin && !flags.version)) {
    process.stdout.write(USAGE);
    return flags.help ? EXIT.ok : EXIT.usage;
  }
  if (flags.version) {
    process.stdout.write(`${require("../package.json").version}\n`);
    return EXIT.ok;
  }

  const prompt = flags.stdin ? await readStdin(process.stdin) : parsed.prompt;
  if (!prompt) { process.stderr.write("crowe: nothing to do (empty request)\n"); return EXIT.usage; }

  /* SIGINT is the Stop button. It has to do both halves of what Stop does:
     mark the turn aborted so the loop stops asking for more, and abort the
     in-flight request so the current call returns now rather than at its own
     pace. A second one means the user is done being polite. */
  let stopFn = null;
  let stopped = false;
  process.on("SIGINT", () => {
    if (stopped) process.exit(EXIT.stopped);
    stopped = true;
    process.stderr.write("\n  stopping (press Ctrl-C again to exit now)\n");
    if (stopFn) stopFn();
  });

  return runOnce({ prompt, flags, onSignal: (fn) => { stopFn = fn; } });
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`crowe: ${String((e && e.stack) || e)}\n`); process.exitCode = EXIT.error; });
}

module.exports = { main, parseArgs, USAGE, EXIT };
