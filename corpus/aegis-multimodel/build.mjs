import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const corpusDir = import.meta.dirname;
const projectRoot = resolve(corpusDir, "../..");
const glmSource = resolve(
  process.argv[2]
    ?? "/Users/crowelogic/.codex/attachments/cd70b078-2d88-4ca4-a4a2-681d9cf0d461/pasted-text.txt",
);

const normalize = (text) => text
  .replaceAll("\r\n", "\n")
  .replaceAll("\u2014", "-")
  .replaceAll("SKEEPTIC", "SKEPTIC")
  .replace(/[ \t]+$/gm, "")
  .trim();

const prompt = normalize(await readFile(resolve(corpusDir, "prompt.md"), "utf8"));
const glm = normalize(await readFile(glmSource, "utf8"));
const claude = normalize(await readFile(resolve(corpusDir, "claude-opus.md"), "utf8"));
const codex = normalize(await readFile(resolve(corpusDir, "codex-gpt-5.md"), "utf8"));
const deepseekEvents = (await readFile(
  resolve(corpusDir, "deepseek-v4-pro.events.jsonl"),
  "utf8",
))
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const deepseek = normalize(
  deepseekEvents
    .filter((event) => event.type === "text")
    .map((event) => event.part?.text ?? "")
    .join(""),
);
const deepseekFinish = deepseekEvents.findLast(
  (event) => event.type === "step_finish",
);
const kimiResponse = JSON.parse(
  await readFile(resolve(corpusDir, "kimi-k2.6.response.json"), "utf8"),
);
if (kimiResponse.error) {
  throw new Error(`Kimi generation failed: ${kimiResponse.error.message}`);
}
const kimi = normalize(kimiResponse.choices?.[0]?.message?.content ?? "");

const models = [
  {
    id: "glm-5.2",
    provider_model: "z.ai/glm-5.2",
    response: glm,
    usage: null,
    source: "user-provided z.ai response",
  },
  {
    id: "deepseek-v4-pro",
    provider_model: "azure/deepseek-v4-pro",
    response: deepseek,
    usage: {
      tokens: deepseekFinish?.part?.tokens ?? null,
      cost: deepseekFinish?.part?.cost ?? null,
    },
    source: "OpenCode CLI",
  },
  {
    id: "claude-opus",
    provider_model: "claude/opus",
    response: claude,
    usage: null,
    source: "Claude Code CLI",
  },
  {
    id: "kimi-k2.6",
    provider_model: "azure/Kimi-K2-6",
    response: kimi,
    usage: {
      tokens: kimiResponse.usage ?? null,
      cost: null,
    },
    source: "Azure AI Services REST via CLI",
  },
  {
    id: "codex-gpt-5",
    provider_model: "openai/gpt-5",
    response: codex,
    usage: null,
    source: "Codex agent",
  },
];

if (models.some((model) => model.response.length < 1_000)) {
  throw new Error("One or more model responses are unexpectedly short");
}

const promptSha256 = createHash("sha256").update(prompt).digest("hex");
const common = {
  corpus_id: "aegis-multimodel-v1",
  record_type: "instruction",
  collected_at: "2026-07-28",
  language: "en",
  domains: [
    "agentic-systems",
    "computer-engineering",
    "software-engineering",
    "embedded-systems",
    "hdl-fpga",
    "hardware-in-the-loop",
  ],
  prompt_sha256: promptSha256,
  instruction: prompt,
};

const records = models.map((model) => ({
  ...common,
  id: `aegis-multimodel-v1:${model.id}`,
  provider_model: model.provider_model,
  response: model.response,
  source: model.source,
  usage: model.usage,
  response_sha256: createHash("sha256").update(model.response).digest("hex"),
}));

const metrics = models.map((model) => ({
  id: model.id,
  provider_model: model.provider_model,
  characters: model.response.length,
  words: model.response.split(/\s+/).length,
  headings: (model.response.match(/^#{1,4} /gm) ?? []).length,
}));

const blockedModels = [
  {
    id: "gemini-3.1-pro",
    provider_model: "google/gemini-3.1-pro-preview",
    reason: "Vertex OAuth and API enablement succeeded, but Google Lightning dunning denied both billed projects; GitHub Copilot premium usage is also exhausted",
  },
];

const manifest = {
  corpus_id: "aegis-multimodel-v1",
  version: 1,
  created_at: "2026-07-28",
  prompt_sha256: promptSha256,
  completed_models: models.map(({ id, provider_model, source }) => ({
    id,
    provider_model,
    source,
  })),
  blocked_models: blockedModels,
  metrics,
  record_count: records.length,
};

const comparison = [
  "# Aegis Multi-Model Corpus",
  "",
  "| Model | Characters | Words | Headings | Status |",
  "|---|---:|---:|---:|---|",
  ...metrics.map(
    (metric) =>
      `| ${metric.provider_model} | ${metric.characters} | ${metric.words} | ${metric.headings} | Complete |`,
  ),
  ...blockedModels.map(
    (model) => `| ${model.provider_model} | - | - | - | Blocked |`,
  ),
  "",
  "All completed models received the same prompt. Web browsing and external tools were disabled.",
  "",
  "## Blocked providers",
  "",
  ...blockedModels.map(
    (model) => `- ${model.provider_model}: ${model.reason}`,
  ),
  "",
].join("\n");

await Promise.all([
  writeFile(resolve(corpusDir, "glm-5.2.md"), `${glm}\n`),
  writeFile(resolve(corpusDir, "deepseek-v4-pro.md"), `${deepseek}\n`),
  writeFile(resolve(corpusDir, "kimi-k2.6.md"), `${kimi}\n`),
  writeFile(
    resolve(corpusDir, "claude-opus.md"),
    `${claude}\n`,
  ),
  writeFile(resolve(corpusDir, "codex-gpt-5.md"), `${codex}\n`),
  writeFile(
    resolve(corpusDir, "corpus.jsonl"),
    `${records.map(JSON.stringify).join("\n")}\n`,
  ),
  writeFile(
    resolve(corpusDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ),
  writeFile(resolve(corpusDir, "README.md"), comparison),
]);

console.log(JSON.stringify(manifest, null, 2));
