import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [inputArg, outputArg = "corpus/aegis-agentic-harness"] = process.argv.slice(2);
if (!inputArg) {
  throw new Error("Usage: node scripts/build-aegis-corpus.mjs <source.txt> [output-dir]");
}

const inputPath = resolve(inputArg);
const outputDir = resolve(outputArg);
const raw = await readFile(inputPath, "utf8");
const cleaned = raw
  .replaceAll("\r\n", "\n")
  .replaceAll("\u2014", "-")
  .replaceAll("SKEEPTIC", "SKEPTIC")
  .replace(/[ \t]+$/gm, "")
  .trim();

const prompt = [
  "Design a production-grade agentic harness for heavy-duty computer engineering and software programming.",
  "Support large C/C++/Rust/Python/TypeScript codebases, HDL and FPGA work, embedded firmware, kernel and driver development, distributed systems, build systems, CI, debugging, simulation, formal verification, hardware-in-the-loop testing, and long-running multi-agent tasks.",
  "Cover architecture, agent roles, tool and sandbox contracts, context and memory, deterministic state and recovery, security, evaluation, model routing, schemas, and a phased roadmap.",
].join(" ");

const sectionMatches = [...cleaned.matchAll(/^### (\d+)\. (.+)$/gm)];
const sections = sectionMatches.map((match, index) => {
  const start = match.index;
  const end = sectionMatches[index + 1]?.index ?? cleaned.length;
  return {
    number: Number(match[1]),
    title: match[2].trim(),
    content: cleaned.slice(start, end).trim(),
  };
});

if (sections.length !== 10) {
  throw new Error(`Expected 10 sections, found ${sections.length}`);
}

const sourceSha256 = createHash("sha256").update(raw).digest("hex");
const corpusId = "aegis-agentic-harness-v1";
const common = {
  corpus_id: corpusId,
  language: "en",
  model: "GLM-5.2",
  source_type: "user-provided-model-response",
  source_file: basename(inputPath),
  source_sha256: sourceSha256,
  collected_at: "2026-07-28",
  domains: [
    "agentic-systems",
    "computer-engineering",
    "software-engineering",
    "embedded-systems",
    "hdl-fpga",
    "hardware-in-the-loop",
  ],
};

const records = [
  {
    ...common,
    id: `${corpusId}:instruction:full`,
    record_type: "instruction",
    instruction: prompt,
    response: cleaned,
    topics: sections.map(({ title }) => title),
  },
  ...sections.map((section) => ({
    ...common,
    id: `${corpusId}:knowledge:${String(section.number).padStart(2, "0")}`,
    record_type: "knowledge",
    title: section.title,
    text: section.content,
    section_number: section.number,
    topics: [section.title],
  })),
];

const manifest = {
  corpus_id: corpusId,
  version: 1,
  created_at: "2026-07-28",
  source_sha256: sourceSha256,
  record_count: records.length,
  record_types: {
    instruction: 1,
    knowledge: sections.length,
  },
  transformations: [
    "Normalized line endings",
    "Removed trailing whitespace",
    "Replaced em dashes with hyphens",
    "Corrected SKEEPTIC to SKEPTIC",
    "Split the response at its ten numbered section headings",
  ],
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(`${outputDir}/source.md`, `${cleaned}\n`),
  writeFile(`${outputDir}/corpus.jsonl`, `${records.map(JSON.stringify).join("\n")}\n`),
  writeFile(`${outputDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`),
]);

console.log(JSON.stringify(manifest));
