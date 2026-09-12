import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Opt-in real-browser confirmation batch. Serial and paced; stop on rate limits.
const cases = [
  ["recall", "15625", "chatgpt-web/medium", "words"],
  ["recall", "15750", "chatgpt-web/medium", "words"],
  ["compaction", "15000", "chatgpt-web/medium", "words"],
  ["recall", "15000", "chatgpt-web/medium", "code"],
  ["compaction", "15000", "chatgpt-web/medium", "chinese"],
  ["compaction", "15000", "chatgpt-web/high", "words"],
  ["compaction", "15000", "chatgpt-web/pro", "words"],
  ["recall", "15625", "chatgpt-web/medium", "words"],
];
const root = resolve("runtime", `live-confirmation-${Date.now()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
writeFileSync(join(root, "plan.json"), JSON.stringify(cases), { mode: 0o600 });
let next = 0;
const results: unknown[] = [];
async function worker() {
  while (next < cases.length) {
    if (next > 0) await new Promise(resolve => setTimeout(resolve, 60_000));
    const index = next++, args = cases[index]!;
    console.log(JSON.stringify({ event: "CASE_START", index, args }));
    const child = Bun.spawn([process.execPath, "run", "scripts/smoke-live-review.ts", ...args], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    writeFileSync(join(root, `${index}.log`), stdout + stderr, { mode: 0o600 });
    const summaryLine = stdout.split("\n").find(line => line.startsWith('{"event":"LIVE_REVIEW_RESULT"'));
    const summary = summaryLine ? JSON.parse(summaryLine) : { error: stderr.slice(-2_000) };
    results.push({ index, args, exitCode, summary });
    writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ event: "CASE_END", index, exitCode, passed: summary.passed,
      hits: summary.score?.recalled, tokens: summary.compiled?.inputTokens, root: summary.root }));
    if (summary.status === 429 || summary.error?.code === "rate_limit_exceeded") {
      console.log(JSON.stringify({ event: "RATE_LIMIT_STOP", index }));
      break;
    }
  }
}
console.log(JSON.stringify({ event: "BATCH_START", root, count: cases.length }));
await worker();
console.log(JSON.stringify({ event: "BATCH_END", root }));
