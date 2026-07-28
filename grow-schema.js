/* The record types the grower's store holds, and the fields each one has.

   Shared by main (which validates what gets written to disk) and harness (which
   describes the log_grow tool to the model). The renderer's GROW table carries
   the same keys plus its labels, widths and accessors; scripts/test-panels.js
   asserts the two stay in step, because a key that exists on one side and not
   the other is data the grower dictates, the agent reports as logged, and the
   lane never shows again.

   `d` is what the model is told the field means - it goes into the tool
   description, so it is written for a reader who cannot see the form. `opts` is
   a closed set: a value outside it is refused rather than coerced, because the
   lane renders a <select> and a stage nobody can select is a row the grower
   cannot correct. */
const GROW_SCHEMA = {
  blocks: {
    what: "a substrate block or lot, from spawn to spent",
    fields: [
      { k: "code", d: "lot code, e.g. 260722-01" },
      { k: "species", d: "e.g. Blue oyster, Lion's mane" },
      { k: "strain", d: "strain or isolate name" },
      { k: "substrate", d: "substrate recipe name" },
      { k: "count", d: "how many blocks in the lot (number)" },
      // Where it is growing. MGAP 12.1a wants lot tagging traceable to location
      // and date of harvest; indoors the room is the location, and without it a
      // trace cannot say which environment a lot actually saw.
      { k: "room", d: "room it is growing in, matching the Environment room name" },
      { k: "spawned", d: "date spawned, YYYY-MM-DD" },
      { k: "stage", d: "current stage", opts: ["spawned", "colonizing", "consolidating", "fruiting", "spent", "discarded"] },
      { k: "notes", d: "free text" },
    ],
  },
  flushes: {
    what: "a harvest off a block",
    fields: [
      { k: "block", d: "the lot code this came off" },
      { k: "n", d: "which flush, 1 for the first (number)" },
      { k: "date", d: "date harvested, YYYY-MM-DD" },
      { k: "weight", d: "weight in pounds (number)" },
      { k: "grade", d: "quality grade", opts: ["A", "B", "cull"] },
      { k: "notes", d: "free text" },
    ],
  },
  contam: {
    what: "a contamination event",
    fields: [
      { k: "block", d: "the lot code affected" },
      { k: "organism", d: "what it is", opts: ["Trichoderma", "Penicillium", "Aspergillus", "Neurospora", "bacterial / wet spot", "cobweb", "unknown"] },
      { k: "stage", d: "where it was caught", opts: ["grain spawn", "substrate", "colonizing", "fruiting", "post-harvest"] },
      { k: "date", d: "date found, YYYY-MM-DD" },
      { k: "action", d: "what was done about it", opts: ["discarded", "isolated", "salvaged", "monitoring"] },
      { k: "notes", d: "free text" },
    ],
  },
  env: {
    what: "a room reading, entered by hand",
    fields: [
      { k: "room", d: "room name, e.g. Fruiting B" },
      { k: "date", d: "date of the reading, YYYY-MM-DD" },
      { k: "temp", d: "temperature in °F (number)" },
      { k: "rh", d: "relative humidity % (number)" },
      { k: "co2", d: "CO2 in ppm (number)" },
      { k: "fae", d: "fresh air exchange setting" },
      { k: "notes", d: "free text" },
    ],
  },
  strains: {
    what: "a strain held in the library",
    fields: [
      { k: "name", d: "strain name" },
      { k: "species", d: "species" },
      { k: "source", d: "where it came from" },
      { k: "gen", d: "generation, e.g. 3 for a third transfer (number)" },
      { k: "acquired", d: "date acquired, YYYY-MM-DD" },
      { k: "notes", d: "free text" },
    ],
  },
  recipes: {
    what: "a substrate recipe",
    fields: [
      { k: "name", d: "recipe name" },
      { k: "base", d: "base material, e.g. hardwood sawdust" },
      { k: "supplement", d: "supplement, e.g. wheat bran" },
      { k: "hydration", d: "target moisture % (number)" },
      { k: "process", d: "how it is sterilized or pasteurized" },
      { k: "notes", d: "free text" },
    ],
  },
  log: {
    what: "a dated note in the grow journal",
    fields: [
      { k: "date", d: "date, YYYY-MM-DD" },
      { k: "subject", d: "what it is about" },
      { k: "entry", d: "the note itself" },
    ],
  },
};

const GROW_TYPES = new Set(Object.keys(GROW_SCHEMA));

/* Check a record the way the form does, and say why in words the model can act
   on. Returns { ok, record } or { ok: false, error }.

   Unknown keys are refused rather than dropped. Dropping is the worse failure:
   the write succeeds, the tool reports success, and the one field the grower
   actually cared about is gone with no trace. Refusing tells the model which
   keys exist so its next call is right. */
function growValidate(type, record) {
  const def = GROW_SCHEMA[type];
  if (!def) return { ok: false, error: `unknown record type "${type}". Valid types: ${[...GROW_TYPES].join(", ")}.` };
  if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, error: "record must be an object of field names to values." };
  const keys = new Set(def.fields.map((f) => f.k));
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === "id") { out.id = String(v); continue; } // correcting an existing row
    if (!keys.has(k)) return { ok: false, error: `"${k}" is not a field on ${type}. Fields: ${[...keys].join(", ")}.` };
    const f = def.fields.find((x) => x.k === k);
    const s = v == null ? "" : String(v).trim();
    if (f.opts && s && !f.opts.includes(s))
      return { ok: false, error: `"${s}" is not a valid ${k} for ${type}. Choose one of: ${f.opts.join(", ")}.` };
    // Dates are stored as the form writes them, because the lane parses them at
    // local midnight and an ISO timestamp would land on the wrong day.
    if (/^(date|spawned|acquired)$/.test(k) && s && !/^\d{4}-\d{2}-\d{2}$/.test(s))
      return { ok: false, error: `${k} must be YYYY-MM-DD, got "${s}".` };
    out[k] = s.slice(0, 2000);
  }
  if (!Object.keys(out).filter((k) => k !== "id").length) return { ok: false, error: "no fields given - an empty record is not a record." };
  return { ok: true, record: out };
}

module.exports = { GROW_SCHEMA, GROW_TYPES, growValidate };
