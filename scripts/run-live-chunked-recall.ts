import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { validateLiveContextFixture } from "./live-context-fixture";

// Feasibility experiment, not a production feature: bounded independent extraction, then synthesis.
const inputPath = resolve(process.argv[2] ?? "runtime/staging-comparison-1789222070098/fixture.json");
const original = validateLiveContextFixture(JSON.parse(readFileSync(inputPath, "utf8")));
const root = resolve("runtime", `chunked-recall-${Date.now()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const results: any[] = [];
async function run(label: string, fixturePath: string, range?: string) {
  console.log(JSON.stringify({ event: "CHUNK_START", label, range }));
  const child = Bun.spawn([process.execPath, "run", "scripts/smoke-live-review.ts", "recall", range ? "40000" : "1", "chatgpt-web/medium", "words", "medium"], {
    env: { ...process.env, CGW_LIVE_FIXTURE: fixturePath, CGW_LIVE_RECORD_RANGE: range ?? "", CGW_LIVE_NETWORK_TRACE: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(root, `${label}.log`), stdout + stderr, { mode: 0o600 });
  const line = stdout.split("\n").find(text => text.startsWith('{"event":"LIVE_REVIEW_RESULT"'));
  if (!line) throw new Error(`No result for ${label}`);
  const partial = JSON.parse(line);
  const summary = JSON.parse(readFileSync(join(partial.root, "summary.json"), "utf8"));
  results.push({ label, exitCode, summary });
  writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "CHUNK_END", label, passed: summary.passed, score: summary.score?.recalled, root: summary.root }));
  if (!summary.passed) throw new Error(`Stopping after failed chunk ${label}; no retries or alternate models`);
  return summary.output as string;
}
console.log(JSON.stringify({ event: "CHUNKED_RECALL_START", root }));
const outputs: string[] = [];
for (let i = 0; i < 4; i++) {
  if (i > 0) await new Promise(resolve => setTimeout(resolve, 60_000));
  outputs.push(await run(`extract-${i + 1}`, inputPath, `${i * 2 + 1}:${i * 2 + 2}`));
}
// Build synthesis input from actual model outputs only, never inject unobserved expected answers.
const extracted = outputs.flatMap(text => [...text.matchAll(/\bR\d{2}(?:HEAD|MID|TAIL)[A-F0-9]{12}\b/g)].map(match => match[0]));
const reduced = { ...original, content: original.content.map((_text, index) =>
  `Extracted record ${index + 1}:\n` + extracted.filter(token => token.startsWith(`R${String(index + 1).padStart(2, "0")}`)).join("\n")),
};
const reducedPath = join(root, "extracted-fixture.json");
writeFileSync(reducedPath, JSON.stringify(validateLiveContextFixture(reduced)), { mode: 0o600 });
await new Promise(resolve => setTimeout(resolve, 60_000));
await run("synthesis", reducedPath);
console.log(JSON.stringify({ event: "CHUNKED_RECALL_COMPLETE", root }));
