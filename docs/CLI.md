# The headless runner

`crowe` is the desktop agent without the desktop. Same `harness.js`, same tiers,
same gates, same verifier, same journal. What changes is the surface: a terminal
instead of a window, an exit code instead of a transcript, and one JSON event per
line instead of a rendered thread.

It exists for the places the app cannot go. CI. A remote box over SSH. A cron
job. A hosted worker running a customer's turn under that customer's entitlement.

```
crowe "rename the timeout constant and update its callers"
crowe --tier execute --yes --json "run the tests and fix what fails"
echo "summarize the staged diff" | crowe -
```

## The rule this thing is built around

The harness enforces every gate on its own side of the call. The CLI does not get
to be friendlier than the app, and none of the checks are skipped because nobody
is watching:

- The autonomy tier still decides what exists. `plan` and `readonly` cannot write,
  `edit` cannot reach the shell, only `execute` can.
- Risk classification still runs, so an irreversible command still needs a yes.
- Approvals are still one-shot, still bound to the hash of the exact arguments,
  and still expire after five minutes.
- The secret blocklist still refuses to read a credential file, and the value
  scanner still refuses to write one out.
- The verifier still checks a turn that changed something, independently, on its
  own tool list, without the operator's transcript.
- The journal is still hash-chained, so a receipt cannot be quietly rewritten.

The one thing that genuinely differs is who answers the question at the end of a
gate. The app draws a card. This asks the terminal. And when there is no terminal
at all, it denies, because an unanswered approval has always been a denial and a
pipe is the loudest possible way of not answering.

`--yes` changes the answer, never the question. Every gate still runs and every
check still applies; the approval prompt is simply answered yes. It does not
widen the tier, so `--yes` at `edit` still cannot run a shell command.

## Options

| Flag | Meaning |
| --- | --- |
| `--tier <t>` | `plan`, `readonly`, `edit` (default), `execute` |
| `--approvals <m>` | `off`, `high-risk` (default), `strict` |
| `--model <name>` | pin a deployment instead of routing to one |
| `--role <name>` | pin an expert instead of classifying the request |
| `--cwd <path>` | run against this directory |
| `--yes` | answer approval prompts with yes |
| `--auto-approve` | apply file edits without review |
| `--no-verifier` | skip the independent check of a mutating turn |
| `--budget <usd>` | spend ceiling for the turn, 0 for none |
| `--token-cap <n>` | token ceiling for the turn, 0 for none |
| `--base-url <url>` | gateway base URL |
| `--token <jwt>` | Crowe ID bearer token |
| `--no-catalog` | skip the catalog fetch and route from the bridge table |
| `--json` | one JSON event per line on stdout |
| `--quiet` | print only the final answer |

An unrecognised value for `--tier` or `--approvals` is an error rather than a
downgrade. A typo in a flag is a mistake worth stopping for; a typo in a config
file is not, so there the value falls back to the safe end instead.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | finished |
| 1 | the gateway call or the run failed |
| 2 | stopped (SIGINT) |
| 3 | the verifier failed the turn |
| 4 | bad usage |
| 5 | hit the tool-round limit or a spend ceiling before finishing |

3 and 5 are the two worth wiring into a pipeline. A failed verdict means the
agent's claim did not survive an independent check, and a capped turn means the
work is incomplete rather than wrong.

## Output

`--json` is the contract for anything programmatic. One event per line on stdout,
every event the harness emits, nothing interleaved, terminated by a `result`
line carrying the final text, the stop reason, the verdict, the cost and the
number of mutations.

Without it, the answer goes to stdout and the trace goes to stderr, so
`crowe --quiet "..." > answer.txt` does what it looks like it does.

## Configuration

Precedence is flags, then environment, then the config file, then defaults.

State lives under `CROWE_HOME` (default `~/.crowe`): `cli.json` for config,
`journal/` for the hash-chained receipts, `artifacts/` for spooled tool output,
pruned after seven days.

| Variable | Meaning |
| --- | --- |
| `CROWE_TOKEN` | Crowe ID bearer token |
| `CROWE_BASE_URL` | gateway base URL |
| `CROWE_MODEL` | default deployment |
| `CROWE_AUTONOMY` | default tier |
| `CROWE_APPROVALS` | default approval mode |
| `CROWE_HOME` | state directory |
| `CROWE_CONFIG` | config file path |
| `CROWE_CONTROL_PLANE` | `off`, `local` or `remote` |
| `CROWE_TENANT` | tenant to authorize and meter against |
| `CROWE_WORKSPACE` | workspace within the tenant |

The desktop refreshes an expired token because it owns the sign-in window. The
CLI cannot, so a 401 comes back as an error naming the fix rather than as a
silent unauthorised retry.

## The control plane

Selling hosted access needs two things the local runner does not have: an answer
to "may this tenant run this turn", and a record of what the turn cost. Those are
one interface with two calls, and `--control-plane` chooses who answers them.

```sh
crowe --control-plane local --tenant acme "summarise the failing test"
```

`off` is the default and means no plane at all: the runner behaves exactly as it
did before this existed. `local` backs the same interface with files under
`CROWE_HOME`, so entitlement, quota and metering can be demonstrated and tested
before any hosted service exists. `remote` calls the gateway.

Four things are worth knowing about how it behaves.

**Quota is a ceiling, not a second gate.** The harness already stops a turn that
spends past `turnBudgetUsd`, and it stops it well: a reserve, a closing call, a
real answer. A tenant's remaining quota is expressed in those same units and
whichever ceiling is lower wins, so running out of allowance ends a turn the way
running out of budget does. A quota that is already spent is refused before the
turn starts, because zero means "no ceiling" to the harness and passing it down
would remove the limit rather than enforce it.

**A turn is never billed twice.** Every usage event's id is derived from the
tenant, the turn and the meter rather than generated, so a retry after a timeout
is byte-identical to the original and the plane stores it once. That is what
makes it safe to retry at all.

**Usage outlives the network.** The turn is over by the time its cost is known,
so there is nothing left to fail. Events are written to an outbox first and
delivered when the plane answers. The outbox is bounded and drops oldest first.

**An unreachable plane is not the same as a refusal.** A 402 or a 403 is an
answer and is honoured everywhere. Silence is not, and what it means depends on
the product: the desktop degrades to running the turn and says so in the journal,
because a plane outage must not brick a laptop that is offline; a hosted seat
fails closed, because serving metered access unmetered is giving it away.

Refusals exit `6` and never reach the gateway.

## What is not here yet

MCP servers are a desktop surface today. The CLI declares them absent rather than
faking them, so the model is never offered a tool that cannot run. The grow log
is the same: refused, not stubbed.

## Tests

`scripts/test-cli.js` drives the runner in-process against a scripted gateway and
a temp workspace. `scripts/smoke-cli.js` spawns the real binary against a real
local HTTP gateway and checks that a file actually gets written and a journal
actually gets chained. Both run in `npm test` and in CI.

`scripts/test-cloud.js` covers the control plane on its own: the derived id, the
quota arithmetic, the outbox across a failed delivery, and the degrade policy in
both directions. It runs first, because a billing bug is not something a later
test catches.
