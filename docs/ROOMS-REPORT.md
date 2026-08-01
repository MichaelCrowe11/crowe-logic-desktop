# Rooms — build report

Status: gates 1, 2, 3, 5, 6 and the room surface built and verified. Gate 4's
isolation module is built and proven against real git; the write path stays
closed until an operator can review a diff in the UI, because the module
refuses to merge work nobody has read.

Built on 0.22.0. `node scripts/test-rooms.js` — 28 checks, all passing.

---

## What was built

| | |
|---|---|
| `rooms/registry.js` | The roster and the room templates. Reads the vendored snapshot; computes the ceiling a room may run at. |
| `rooms/agents.vendored.json` | 20 agents, generated from `michaelcrowe11/crowe-agents`. Not hand-written. |
| `scripts/sync-agent-registry.js` | Regenerates that snapshot. The Rooms-only fields are derived here, not authored per agent. |
| `rooms/engine.js` | Addressing, per-agent views, concurrency, status, cost, budget, critique and revise. Pure orchestration over an injected runner. |
| `main.js` | `crowe:rooms:*`, and the real runner that binds the engine to `harness.runAgent`. |
| `preload.js` | `window.crowe.rooms.*`. |
| `mobile/src/mobile-bridge.js` | The same surface, refusing with a stated reason. |
| `scripts/test-rooms.js` | 26 checks. Every mechanically checkable line of the definition of done. |

Two additive changes to `harness.js`: `deps.persona` (who is speaking, appended
to the system prompt unconditionally) and `deps.model` (a seat pins its own
deployment). Both are no-ops when absent, so every existing caller is on its old
path. Harness suite still 74/74.

The canonical registry was extended additively in `michaelcrowe11/crowe-agents`:
`model`, `autonomy_ceiling` and `room_joinable`, all optional with defaults, plus
`registry.py` reading them. `load_registry()` still returns 20 agents and
`can_use_tools` is unchanged.

---

## Definition of done, item by item

**A one-agent room behaving identically to today's operator thread.** Verified.
The single agent makes one call; the transcript it receives is one user message
with no room framing, because there is nobody else in the room; and the room
flattens to exactly the `{role, content}` list the sessions store already holds.

**A three-agent Product Review room on one real SKU, producing three positions.**
Built and exercised — see the transcript below — but with a **scripted runner,
not live models.** This container has no gateway credentials and the proxy
blocks the gateway host, so the model calls are fakes with authored content. The
orchestration is real; the intelligence in the transcript is not. This is the
single largest caveat in this report.

**A critique round in which each agent reviews the others and not itself.**
Verified mechanically. The check asserts, per agent, that its own position is
absent from the brief it receives, that every other agent's position is present,
and that the instruction not to review its own work is in the prompt.

**A revise round in which at least one agent measurably changes its position.**
Verified mechanically against the scripted runner: Product & Formulation moves
from 2 g to 500 mg and names the critique that moved it. Measurable, but
authored — a real model was never asked.

**A stop-all that halts all three mid-flight.** Verified, and verified against
the real mechanism rather than a mock of it. `main.js` registers every room seat
in the same `agentRuns` map that `crowe:agent:stop-all` and
`crowe:operator:stop-all` iterate; the check reproduces that map and that loop
exactly, fires stop with two seats in flight, and asserts no agent ran to
completion, none reported `done`, and no run was left registered.

**A budget cap that actually fires and halts the room.** Verified. A $0.03 room
halts after $0.04 of calls, and subsequent turns make no calls at all and say
why.

**Per-agent cost attribution that sums to the room total.** Verified by
construction rather than by coincidence: one function adds, and it adds to both
the per-agent record and the room total. The check asserts they agree, and that
an agent which did not take a turn was not billed for one.

---

## The transcript

Product Review, three agents, one SKU. Scripted runner. Reproduce with
`node scripts/test-rooms.js`; this narrative run is in the commit message of the
branch rather than checked in as a fixture.

**Opening round.** Product & Formulation opens at two grams for cognitive
performance; Regulatory Affairs says a cognitive claim needs substantiation on
file; Commerce says buyers compare against a $29 shelf.

**Critique round.** Regulatory contests the 2 g claim specifically, citing
21 CFR 101.93 and noting the dose exceeds the cited rodent work. Commerce
contests the formulation on unit cost and notes Regulatory under-states the
packaging cost of a rewrite. Neither reviews itself.

**Revise round.** Product & Formulation drops to 500 mg per capsule, names the
substantiation point as what moved it, and switches to structure/function
wording.

| agent | calls | usd |
|---|---|---|
| Product & Formulation | 3 | 0.036 |
| Regulatory Affairs | 3 | 0.036 |
| Commerce & Support | 3 | 0.036 |
| **room total** | **9** | **0.108** |

Nine calls where the app previously made one, which is exactly the arithmetic
section 6 of the brief warned about: three agents times an opening round, a
critique round and a revise round.

---

## What did not work, and what is not true yet

**Gate 4 is not built, so no room can write.** `roomTier()` clamps every room to
`readonly` regardless of roster or configured autonomy, and the switch that
lifts the clamp defaults to off so forgetting to pass it fails closed. A check
asserts a write-capable roster still lands on `readonly`. This is the gate the
brief called hard, and shipping the write path without worktree isolation is the
one failure that does not recover by looping.

**The surface is built, the switcher is not.** A room opens from the add-panel
palette: a composer offering eight templates and the full twenty-agent roster,
then the room itself with a roster strip carrying live state and spend, messages
attributed by agent name, critiques set apart, `@mention` autocomplete from the
room's own roster, and the projected call count on the critique and revise
buttons. What is still missing is the room switcher in the activity rail beside
Sessions: rooms persist and can be resumed over IPC, but the only way to reopen
one from the UI today is to keep its panel.

**The premise is untested.** The brief is explicit that if critique rounds do
not measurably improve output on a real task, that is the finding. **I cannot
answer that here.** Every model call in this work was a fake with authored
content, so what has been proven is that the critique loop is *wired correctly* —
each agent sees the others' work and not its own, failures are excluded, the cap
holds, the cost is attributed. Whether it makes answers *better* needs a real
gateway, real deployments and a real SKU, and any claim I made about it from
this container would be a claim about my own fixtures.

The honest test, once a gateway is available: run the same SKU through a
three-agent room twice, once stopping after the opening round and once through
critique and revise, and have a human who knows the domain rank the two outputs
blind. If the second is not clearly better, the feature costs three times as
much for nothing and should be cut back to the opening round.

**Two bugs the tests caught, worth recording because both would have shipped.**

The registry contains an agent whose id is literally `operator`, and the human
operator was using the same string as an author id. An agent's answer was
therefore attributed to the person, flattened into the session as a user
message, and would have been read back on the next turn as the operator's own
words. Fixed with a reserved author id that registry ids cannot collide with.

`listTemplates()` returned agent ids where every caller expected resolved
objects, so `fromTemplate()` composed rooms with undefined agents and the
templates silently produced empty rosters.

**Not verified here:** anything requiring Electron IPC end to end. The IPC
handlers are syntax-checked and the engine beneath them is covered, but no test
drives `crowe:rooms:say` through a live `ipcMain`. The first renderer work
should carry that.


---

## Addendum: the composer, and what it says about verticals

The first four templates leaned cultivation, which made a general mechanism look
like a vertical feature. The registry underneath spans sixteen domains, and
three of its twenty agents are mycology.

Two things closed that gap. Four more templates - Launch Review, Security
Posture, Molecule Triage, The Week - built entirely from agents that already
existed, and a composer that offers the whole roster so a room can be any
argument rather than one of eight. Driven in a browser: a room composed from
Revenue, Compliance & Audit and Studio Director, three verticals no template
names, runs exactly as a template room does.

A rule the tests now hold, and worth stating because it is the product's
honest boundary: **a room earns its cost when a decision has more than one
binding constraint, and where there is only one, a single agent is the right
answer.** The composer says this above the templates. A catalogue that implied
every question deserves three specialists would teach people to spend triple for
nothing.

One test of that rule caught a flaw in the rule rather than the code. A check
that rejected single-`domain` templates flagged The Week, whose three agents all
carry the `operations` tag while answering completely different questions about
the same week. The registry's domain field is coarser than the specialties
inside it, so the per-template check now asks whether the same specialty is
seated twice, and the domain field is used where it is actually meaningful: for
asserting that the curated set as a whole reaches across the business.


---

## Gate 4: what is built, and why the clamp is still on

`rooms/worktrees.js` gives each write-capable agent its own `git worktree` on
its own branch from the room's base commit, produces its work as a diff against
that base, and lands diffs one at a time with a review in between.

Six checks in `scripts/test-rooms.js` cover the ordering rules against an
injected fake git: a tree and branch per agent, an unreviewed diff refused, a
review of one agent not clearing another, a conflicting merge reported with the
branch left standing, an empty diff landing as nothing rather than a commit, and
release taking back checkouts while keeping branches.

Those checks prove the rules. They do not prove the mechanics, so the module was
also run against a real repository with two agents editing different files in
the same checkout:

```
trees made: r-real--alpha + r-real--beta
ISOLATION - beta sees alpha edit: false
ISOLATION - workspace sees alpha edit: false
alpha diff stat: "a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)"
unreviewed merge refused: true
alpha landed: true | workspace has ALPHA: true
beta landed: true | b.txt: beta-only
released: true | branches kept: 2 | workspace clean: yes
```

The two isolation lines are the ones that matter: an agent's edit is invisible
to every other agent and to the workspace until it is reviewed and landed.

**The clamp stays on anyway.** `roomTier()` still forces `readonly`, because
merging requires a reviewed diff and there is nowhere in the UI to read one.
Lifting the clamp before that exists would produce rooms that can write and
cannot land, which is worse than rooms that cannot write. What remains is the
wiring: an isolation context per room in `main.js`, agent runs rooted in their
own tree, IPC for diff and merge, and a review surface. The gate is called hard
in the build order and this is what honouring that looks like - the dangerous
half is finished and proven, and it stays switched off until the half that makes
it usable is finished too.


---

## Addendum: the chain, in one piece

Every suite above cuts the chain somewhere. `scripts/test-rooms.js` injects a
fake runner, so it proves the engine's rules and never touches IPC. The browser
preview drives the renderer against a shim, so it proves the surface and never
reaches `main.js`. Both were green while `crowe:rooms:say` had never once been
called through a live `ipcMain` - which is the kind of gap two green suites hide
between them.

`scripts/test-rooms-live.js` boots the real app the way `smoke-shot.js` does and
drives a room from inside the renderer through the same `window.crowe` the
product uses. Only the network is replaced, at the process's own `fetch`:

```
rooms, end to end
  ok   the roster and templates come back through ipcMain - 20 agents, 8 templates
  ok   a room is created and persists through the sessions store - at plan
  ok   addressing one agent spends one call, not three - answered by regulatory-affairs
  ok   @room reaches every seat, and the answers are attributed
  ok   a critique round reviews the others and never itself - three critics
  ok   cost is attributed per seat and sums to the room total - 7 calls, $0.0032
  ok   a reloaded room restores every agent's view of the transcript - 9 messages, 4 authors
  ok   stop-all halts the room's agents through the real handler
```

Pointing `baseUrl` at a loopback server was the obvious approach and the wrong
one: `loadConfig()` rewrites a loopback gateway back to the real host on purpose,
so a stale dev URL cannot brick a member install. Weakening that guard to make a
test pass would have traded a real protection for a convenience, so the fake sits
at `fetch` instead and every line of the product - config, guard, harness, IPC -
runs untouched.

### What it found

**A signed-in headless shell was signed out again on the next config load.**
`writeAuthStore()` has a plaintext fallback for machines with no keychain, gated
on `CROWE_ALLOW_PLAINTEXT_AUTH` and an unpackaged build, and its comment names
CI and SSH sessions as the cases it exists for. `readAuthStore()` returned `{}`
before it could ever read that file back, so the escape hatch wrote something
nothing could read. The token vanished with no error anywhere to say why. Fixed
by mirroring the fallback on the read side under the same two conditions.

This is shipped code on `main`, not room code, and no suite in the repo could
have caught it: every other test either avoids auth or runs where a keychain
exists.

### What it still does not prove

The model is a stub returning a fixed sentence. This proves the wiring - who is
addressed, who spends, who reviews whom, what persists - and it does not prove
that a critique round makes an answer better. That remains the blind A/B in the
section above, and it needs a real gateway.


### The suites were not running in CI

Worth recording, because it made every green check on this branch mean less
than it looked. `.github/workflows/ci.yml` runs seven scripts by name rather
than `npm test`, and `scripts/test-rooms.js` was not one of them. Thirty-six
engine checks and eight end-to-end checks had only ever run on a developer's
machine, while the pull request reported green.

The same gap covered `scripts/test-packaging.js`, which is the suite that caught
`rooms/` missing from the build allowlist - a crash at startup in a packaged app
that no other suite can see, because they all run from the source tree where the
file is present.

Both are in `ci.yml` now, along with the end-to-end run. The wider gap is real
and left alone deliberately: `test-companion.js`, `test-qr.js`, `test-icons.js`
and `test-install-spaces.js` are also absent from CI while passing locally.
Adding them is a repository decision rather than part of this feature, and
naming it here is more useful than quietly widening this branch.
