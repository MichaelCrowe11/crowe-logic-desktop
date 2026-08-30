# Measuring what Crowe Logic actually does for people

A design for productivity research on the desktop app, in two populations:
developers and growers. Written against the code as of 0.24.3; every claim
about what the app records today is cited to a file and line, and everything
that would have to be built says so rather than implying it exists.

The prompt for this document was GitHub's 2022 Copilot research
([Kalliamvakou et al.](https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-on-developer-productivity-and-happiness/)):
a >2,000-person survey scored on the SPACE framework, plus a 95-developer
controlled experiment that found a 55% speed gain on writing an HTTP server in
JavaScript. The question here is whether that method transfers. It half does.
The survey half transfers almost unchanged. The experiment half does not
survive contact with either of our products — for opposite reasons — and the
replacements are different in each case.

## Why the Copilot design does not port cleanly

Three mismatches, before any of the good news.

**1. Different unit of work.** Copilot is an autocomplete: the measurable event
is a suggestion shown and accepted, thousands of times a day, and "faster"
is the natural axis. Crowe Logic is an operator loop — the agent proposes,
the human reviews a diff, the edit lands or is rejected
(`harness.js:225` marks `edit_file`, `write_file` and `log_grow` as
compensatable, i.e. reviewable and undoable). The unit is an accepted change,
not a keystroke. Counting characters saved would measure the wrong product.

**2. Different n.** GitHub ran the survey across a technical preview with
thousands of users. A private beta does not have that, and a survey of 40
people reported as "% who agree" is a chart with no confidence interval behind
it. The designs below are built to be honest at n in the tens: within-subject
where possible, deterministic scoring where available, and effect sizes
reported with intervals or not reported at all.

**3. Different observability, on purpose.** The app's telemetry is opt-out and
deliberately thin. `telemetryExtra()` (`main.js:50`) sends version, platform,
arch, channel and model name — nothing else — and exactly three events exist:
`app_launch` (`main.js:1553`), `agent_turn` with a turn count and agent id
(`main.js:910`), and `main_exception` (`main.js:1554`). No message content, no
file paths, no tokens; the privacy policy commits to that in writing
(`docs/legal/PRIVACY.md`). Cultivation records never leave the machine at all.

That last constraint is usually read as a handicap for research. It is not.
SPACE is mostly counters, durations and self-reports, none of which need
content. The constraint does rule out one whole class of study — no
"we analyzed what our users' code looks like" — and it forces the agricultural
work to be consented and on-farm rather than telemetric. Both are fine.

## The developer study

### What to measure, mapped to SPACE

| SPACE dimension | Metric | Exists today? |
| --- | --- | --- |
| **S**atisfaction | Post-session single-item prompt ("Did this session go the way you wanted?"), plus a quarterly instrument reusing GitHub's item wording so results are comparable | No — needs an in-app survey surface |
| **P**erformance | Task completion against the repo's own test suite; accepted-diff rate (edits approved ÷ edits proposed) | Partly — the review outcome is known in the renderer but not counted |
| **A**ctivity | Turns per session, tool calls per accepted change, sessions per week | Partly — `agent_turn` carries turn count (`main.js:910`) |
| **C**ommunication | Rooms usage: threads, agents per thread, human interventions per thread (`rooms/engine.js`) | No counters |
| **E**fficiency & flow | Prompt→accepted-diff latency; rejection→retry loops per change; space and lane switches per hour | No |

The two metrics worth building first, because they are the ones that would
actually change the product:

- **Repair rate** — tool calls that fail or are rejected, divided by tool calls
  that land. `harness.js:749` already decides whether a `log_grow` call
  succeeded, and `submit_verdict` (`harness.js:427`) exists for adversarial
  review; the plumbing to count is nearly there. A rising repair rate is the
  clearest early signal that a model change made the loop worse, and it is
  invisible to any speed metric.
- **Rejections per accepted diff.** This is the operator-loop analogue of
  Copilot's acceptance rate, and it is the number that decides whether the
  review gate feels like safety or like tax.

All of these are integers and milliseconds. None require content. They fit
inside the privacy commitment as written, and each new event should be added to
the PRIVACY.md list in the same commit that adds it — the policy claims a
complete enumeration, and a policy that quietly stops enumerating is worse than
no policy.

### The experiment

GitHub's setup — two groups, one task, autograded by GitHub Classroom — has a
direct analogue here, and most of it is already in the repo.

`scripts/run-aegis-multimodel.mjs` runs one hashed prompt
(`corpus/aegis-multimodel/manifest.json` pins `prompt_sha256`) across several
models and records per-run event streams (`*.events.jsonl`). That is a
controlled-comparison rail that already exists; it compares models rather than
people, but the scaffolding — fixed prompt, recorded runs, provenance manifest —
is the same scaffolding.

The scorer is already here too. `npm test` is 20-odd deterministic checks
(`package.json`), several of them adversarial by design: `icons:check` fails if
committed assets drifted from the vectors, `test-panels.js` asserts the grow
schema and the renderer's table stay in step, `test-version-parity.js` and
`build-rooms-web.js --check` fail on divergence. A task scored by "does the
suite go green" is scored the way GitHub Classroom scored theirs, without
building a grader.

So the study is:

- **Design:** within-subject, counterbalanced. Each participant does two
  matched tasks in this codebase, one with the agent loop and one without, in
  randomized order. Within-subject removes between-developer variance, which
  is the dominant noise term at small n and the reason 95 people were needed
  for the between-groups version.
- **Tasks:** drawn from work the repo actually contains — add a field to
  `GROW_SCHEMA` and make `test-panels.js` pass; add a harness tool and its
  success predicate; fix a seeded contrast failure caught by
  `check-contrast.js`. Real, bounded, deterministically scored.
- **Primary outcome:** time to a green suite. **Secondary:** completion rate,
  diff size, and post-task satisfaction.
- **Reporting:** effect size with a confidence interval, the way GitHub
  reported [21%, 89%]. If the interval crosses zero, that is the finding.

One thing worth doing better than the source study: it reported perceived
speed (>90% agreement) and measured speed (55%) side by side without
reconciling them per participant. Collecting both from the same person, on the
same task, and reporting the gap between them is a more interesting result than
either number alone — and at our n it is one of the few analyses small samples
are actually good at.

## The agricultural study

This is where the method gets more interesting than its source, because the
premise of the Copilot paper — "what does it even mean to be productive?" —
mostly dissolves.

### Farms already have the outcome metric software lacks

`grow-schema.js` records flushes with a weight in pounds and a grade
(`A`/`B`/`cull`), blocks with a lot code, count, room, spawn date and stage,
contamination events with organism, stage and action, and room readings with
temp, RH, CO₂ and FAE. Those are not proxies for value. They are the value.
The whole first half of the Copilot post is an argument about which proxy to
trust; a mushroom farm can skip it and measure:

- **Yield per block** and **biological efficiency** (harvest weight ÷ dry
  substrate weight), from `flushes.weight` joined to `blocks.count`.
- **Grade mix** — A-grade share of harvested pounds. Quality, priced.
- **Contamination rate** — contam events per lot, split by the stage they were
  caught at, which the schema already distinguishes (grain spawn vs. substrate
  vs. fruiting).
- **Days spawn → first flush**, from `blocks.spawned` to the earliest flush
  date, the cycle-time metric.
- **Trace completeness** — see below.

### The metric that has no software equivalent

`growTrace()` (`renderer/renderer.js:2906`) reconciles everything the store
knows about one lot and then names, in words, what an auditor would ask for and
the farm cannot produce: no spawn date, no room (MGAP 12.1a wants location), no
block count so yield cannot be reconciled, a substrate with no recipe record, a
flush with no weight. It deliberately refuses to paper over the gaps.

Count those gaps across all open lots and you have **audit readiness as a
number**, computed from records the farm was keeping anyway, movable week over
week, and directly tied to money — Harmonized GAP G-6.1/G-6.2 readiness is what
gates selling into wholesale buyers. No survey required, no proxy argument. It
is the single strongest outcome variable in either study, and it exists in the
code today.

### What breaks, and the design that survives it

The experiment half of the Copilot method breaks completely here. Their task
took 71 minutes. A grow cycle takes weeks, and yield is confounded by strain
generation (`strains.gen` — vigor drops with transfer number), substrate
recipe, room, and season. Ninety-five growers randomized into two groups is not
a study anyone is going to run.

What survives:

- **Within-farm, lot-level alternation.** Same room, same recipe, same strain
  generation, alternating lots logged with the agent's assistance and without.
  The farm is its own control, which kills the between-farm variance that would
  otherwise swamp everything.
- **Stepped wedge across a design-partner cohort.** Five to ten farms adopt in
  a randomized order over a season; each farm contributes pre- and post-
  observations, and the staggered start separates the tool's effect from the
  season's.
- **Interrupted time series on trace completeness.** This one is fast and
  clean: gap count is measurable the day the app is installed and moves within
  weeks, long before a yield signal could exist. It should be the primary
  outcome; yield and contamination are secondary and reported as slower,
  noisier follow-ons.

### The SPACE dimensions still apply — this is the part that transfers whole

GitHub's most durable finding was not the 55%. It was that 87% of developers
said Copilot preserved mental effort on repetitive work, and that letting the
tool carry the boring part is what made the day feel good.

The farm has an exact counterpart, and it is the reason the Cultivation space
has a `log_grow` tool at all. The repetitive, draining, easily-deferred work on
a mushroom farm is recordkeeping — the log entry at the end of a shift, written
by someone with wet gloves who would rather be doing anything else. The
interesting work is strain selection, isolation, reading a room. The hypothesis
is the same shape as GitHub's and testable the same way: **the agent shoulders
the logging, the grower keeps the mycology, and the records get better because
they stop depending on end-of-shift willpower.**

That predicts something specific and falsifiable: records logged per week
should rise, *and* the interval between an event happening and being recorded
should fall. The second is the one that matters — a record written three days
later is where the weight gets estimated and the trace gets soft.

Satisfaction and flow are then measured by asking, as GitHub did: is the
paperwork less draining, and are you spending more of the day on the part of
the job you took it for.

### The constraint that shapes it

Grow records are local JSON and never leave the machine, by design and by
policy. So there is no telemetric version of this study. It has to be a
consented design-partner program in which the farm exports its own records and
shares them deliberately — which is slower, smaller, and better: it comes with
the grower's interpretation attached, and n=8 farms with real yield data beats
n=800 with anonymous counters for a question this concrete.

## What to build first

In order, smallest useful thing first:

1. **Counters for the developer loop** — accepted vs. rejected diffs, tool-call
   repair rate, prompt→accepted-diff latency. Content-free, additive to the
   three existing events, and PRIVACY.md updated in the same commit.
2. **Trace-gap rollup in Cultivation** — `growTrace()` already computes gaps per
   lot; a farm-level count and a week-over-week trend turns an existing
   function into the primary outcome variable, and is a feature growers want
   regardless of any study.
3. **An in-app single-item prompt**, dismissible and off by default, because
   the perceptual half is not optional — it is the half of the Copilot research
   that held up.
4. **The within-subject developer experiment**, using `npm test` as the scorer
   and the aegis corpus rail for provenance.

Steps 1 and 2 are worth doing even if no study is ever run. Step 4 should not
start before step 1, or there will be nothing to check the stopwatch against.

## Honest limits

- Nothing above has been run. This is a design, not a result, and no number in
  it is ours.
- The Copilot survey cohort self-selected into a technical preview and its
  charts report agree + strongly agree, which flatters. Any replication here
  should report full distributions.
- A test suite going green measures completion, not code quality. The Copilot
  team flagged the same gap and had not closed it either.
- Yield effects on a farm are slow and confounded enough that a null result in
  one season would not be evidence of no effect. Trace completeness is proposed
  as primary precisely because it is not.
