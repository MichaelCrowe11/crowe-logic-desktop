#!/usr/bin/env node
// Worker marks: the eight CLI thinking marks as vector, one per worker.
//
//   node scripts/test-marks.js
//
// Pins the contract renderer/marks.js and rooms/registry.js make together:
// eight marks with distinct ids and names, every registry worker resolving to
// one, a deterministic fallback for a worker the registry never named, SVG
// that a browser can size (a viewBox on every mark), no template seating two
// workers with the same mark, and the house rules on every string a person
// might read: no em dash, no emoji, sentence case, and never the two-letter
// word for artificial intelligence standing on its own.

const assert = require("assert");
const Marks = require("../renderer/marks");
const registry = require("../rooms/registry");

const { MARKS, MARK_IDS, markSvg, markFor, setMarkState } = Marks;

// Eight, distinct in id and in name, each with a positive period.
assert.strictEqual(MARKS.length, 8, "eight marks");
assert.strictEqual(new Set(MARKS.map((m) => m.id)).size, 8, "eight unique ids");
assert.strictEqual(new Set(MARKS.map((m) => m.name)).size, 8, "eight unique names");
assert.deepStrictEqual(MARK_IDS, ["mycelial", "hexbloom", "iris", "meshwork", "facet", "convergent", "meridian", "coalesce"], "the CLI rotation order");
for (const m of MARKS) {
  assert(typeof m.period === "number" && m.period > 0, `${m.id} has a period`);
  assert(typeof m.motion === "string" && m.motion.length > 10, `${m.id} describes its motion`);
}

// The brand rules, on every string a person could read: names, motions, and
// the markup itself (an aria-label or title would live there).
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}\u{2600}-\u{27BF}]/u;
const STANDALONE = /(^|[^A-Za-z])AI([^A-Za-z]|$)/;
function brandOk(text, where) {
  assert(!text.includes("—"), `${where}: no em dash`);
  assert(!EMOJI.test(text), `${where}: no emoji`);
  assert(!STANDALONE.test(text), `${where}: the standalone two-letter word is not used`);
}
for (const m of MARKS) {
  brandOk(m.name, `${m.id} name`);
  brandOk(m.motion, `${m.id} motion`);
  // Sentence case: the motion line starts with a capital and does not shout.
  assert(/^[A-Z]/.test(m.motion) && m.motion !== m.motion.toUpperCase(), `${m.id} motion is sentence case`);
}

// Every mark renders as an SVG with a viewBox, the mark id and its state, and
// no inline style (the shells' CSP forbids one).
for (const id of MARK_IDS) {
  for (const state of ["rest", "reasoning", "done"]) {
    const svg = markSvg(id, { size: 24, state });
    assert(svg.startsWith("<svg ") && svg.endsWith("</svg>"), `${id} is an svg element`);
    assert(/\bviewBox="0 0 32 32"/.test(svg), `${id} has a viewBox`);
    assert(svg.includes(`data-mark="${id}"`), `${id} carries data-mark`);
    assert(svg.includes(`data-state="${state}"`), `${id} carries data-state ${state}`);
    assert(svg.includes('width="24" height="24"'), `${id} takes the size it was given`);
    assert(!/\sstyle=/.test(svg), `${id} has no inline style attribute`);
    assert(svg.includes(`class="wm-mark wm-${id}"`), `${id} is addressable by class`);
    brandOk(svg, `${id} markup`);
  }
  const bare = markSvg(id);
  const openTag = bare.match(/^<svg[^>]*>/)[0];
  assert(!/\swidth=/.test(openTag), `${id} without a size fills its host`);
  assert(bare.includes('data-state="rest"'), `${id} rests by default`);
}
// An unknown id and an unknown state degrade to the first mark at rest rather than throwing.
assert(markSvg("nothing", { state: "spinning" }).includes('data-mark="mycelial" data-state="rest"'), "unknown ids and states fall back");

// Every registry worker resolves to one of the eight; every worker the
// registry names explicitly gets exactly that one.
const workers = registry.listAgents();
assert(workers.length >= 8, "the registry has workers to dress");
for (const w of workers) {
  const id = markFor(w);
  assert(MARK_IDS.includes(id), `${w.id} resolves to a mark, got ${id}`);
  assert(typeof w.mark === "string" && MARK_IDS.includes(w.mark), `${w.id} carries an explicit mark in the registry`);
  assert.strictEqual(id, w.mark, `${w.id} wears the mark the registry named`);
}
for (const [id, mark] of Object.entries(registry.MARKS)) {
  assert(MARK_IDS.includes(mark), `registry names a real mark for ${id}, got ${mark}`);
  assert(registry.getAgent(id), `registry names a mark for a worker that exists: ${id}`);
}

// The fallback is deterministic across calls and shaped like the eight, and
// an explicit field wins over it.
assert.strictEqual(markFor({ id: "someone-new" }), markFor({ id: "someone-new" }), "same id, same mark");
assert.strictEqual(markFor("someone-new"), markFor({ id: "someone-new" }), "a bare id hashes the same as a worker");
assert(MARK_IDS.includes(markFor({ id: "someone-new" })), "the fallback lands in the eight");
assert.strictEqual(markFor({ id: "someone-new", mark: "iris" }), "iris", "an explicit mark wins");
assert.strictEqual(markFor({ id: "someone-new", mark: "not-a-mark" }), markFor({ id: "someone-new" }), "an unknown explicit mark falls to the hash");
assert(MARK_IDS.includes(markFor(null)) && MARK_IDS.includes(markFor({})), "no worker at all still gets a mark");
// The hash spreads: a handful of unrelated ids do not all land on one mark.
const spread = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map(markFor));
assert(spread.size >= 4, `the fallback spreads across the eight, got ${spread.size}`);

// No template seats two workers with the same mark (when it has eight or fewer).
for (const t of registry.listTemplates()) {
  if (t.agents.length > 8) continue;
  const marks = t.agents.map(markFor);
  assert.strictEqual(new Set(marks).size, marks.length, `${t.id} seats no two workers with one mark: ${t.agents.map((a) => `${a.id}=${markFor(a)}`).join(", ")}`);
}

// setMarkState works on a bare element shape (no DOM here): a stub with
// dataset and the svg lookup, so the state names are pinned.
function stub(state) {
  const el = { dataset: { state }, matches: (s) => s === "svg.wm-mark", getBoundingClientRect: () => ({}) };
  return el;
}
assert.strictEqual(setMarkState(stub("rest"), "reasoning").dataset.state, "reasoning");
assert.strictEqual(setMarkState(stub("reasoning"), "rest").dataset.state, "rest");
assert.strictEqual(setMarkState(stub("rest"), "spinning").dataset.state, "rest", "an unknown state is rest");
const d = setMarkState(stub("reasoning"), "done");
assert.strictEqual(d.dataset.state, "done", "done is a state the mark passes through");
assert.strictEqual(setMarkState(null, "rest"), null, "no element, no throw");

// The mapping, for the record.
const table = workers.map((w) => `${w.id}=${markFor(w)}`).join(" ");
console.log(`ok      marks: 8 marks, ${workers.length} workers dressed, templates distinct, brand rules hold`);
console.log(`        ${table}`);
