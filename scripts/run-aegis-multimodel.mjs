import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const corpusDir = resolve(root, "corpus/aegis-multimodel");
const promptPath = resolve(corpusDir, "prompt.md");
const prompt = await readFile(promptPath, "utf8");
const promptSha256 = createHash("sha256").update(prompt).digest("hex");

const targets = [
  { id: "deepseek-v4-flash", model: "opencode/deepseek-v4-flash-free" },
  { id: "kimi-k2.7-code", model: "github-copilot/kimi-k2.7-code" },
  { id: "claude-opus-4.8", model: "github-copilot/claude-opus-4.8" },
  { id: "gemini-3.1-pro", model: "github-copilot/gemini-3.1-pro-preview" },
];

function run(target) {
  return new Promise((resolveRun) => {
    const child = spawn(
      "opencode",
      [
        "run",
        "--pure",
        "--format",
        "json",
        "--model",
        target.model,
        "--title",
        `Aegis corpus: ${target.id}`,
        prompt,
      ],
      { cwd: root, env: process.env },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 300_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", async (code) => {
      clearTimeout(timeout);
      const events = stdout
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const response = events
        .filter((event) => event.type === "text")
        .map((event) => event.part?.text ?? "")
        .join("")
        .trim()
        .replaceAll("\u2014", "-");
      const finish = events.findLast((event) => event.type === "step_finish");
      const result = {
        ...target,
        status: code === 0 && response && !timedOut ? "complete" : "failed",
        exit_code: code,
        response,
        events,
        stderr: timedOut ? "Timed out after 300 seconds" : stderr.trim(),
        tokens: finish?.part?.tokens ?? null,
        cost: finish?.part?.cost ?? null,
      };
      await Promise.all([
        writeFile(
          resolve(corpusDir, `${result.id}.md`),
          result.response ? `${result.response}\n` : `Generation failed.\n\n${result.stderr}\n`,
        ),
        writeFile(
          resolve(corpusDir, `${result.id}.events.jsonl`),
          `${result.events.map(JSON.stringify).join("\n")}\n`,
        ),
      ]);
      resolveRun(result);
    });
  });
}

await mkdir(corpusDir, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
for (const target of targets) {
  console.log(`Running ${target.id}...`);
  results.push(await run(target));
}

const records = results
  .filter((result) => result.status === "complete")
  .map((result) => ({
    corpus_id: "aegis-multimodel-v1",
    id: `aegis-multimodel-v1:${result.id}`,
    record_type: "instruction",
    provider_model: result.model,
    prompt_sha256: promptSha256,
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
    instruction: prompt.trim(),
    response: result.response,
    usage: {
      tokens: result.tokens,
      cost: result.cost,
    },
  }));

const manifest = {
  corpus_id: "aegis-multimodel-v1",
  version: 1,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  prompt_sha256: promptSha256,
  requested_models: targets.map(({ id, model }) => ({ id, model })),
  completed_models: results
    .filter((result) => result.status === "complete")
    .map((result) => result.id),
  failed_models: results
    .filter((result) => result.status === "failed")
    .map((result) => ({
      id: result.id,
      exit_code: result.exit_code,
      error: result.stderr.slice(0, 1000),
    })),
  record_count: records.length,
};

await Promise.all([
  writeFile(
    resolve(corpusDir, "corpus.jsonl"),
    `${records.map(JSON.stringify).join("\n")}\n`,
  ),
  writeFile(
    resolve(corpusDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ),
]);

console.log(JSON.stringify(manifest, null, 2));
if (manifest.failed_models.length) process.exitCode = 1;
