import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { makeLiveContextFixture } from "./live-context-fixture";

// A matched direct-recall experiment. Never changes installed code or account settings.
const root = resolve("runtime", `staging-comparison-${Date.now()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const fixturePath = join(root, "fixture.json");
writeFileSync(fixturePath, JSON.stringify(makeLiveContextFixture("words", 40_000)), { mode: 0o600 });
const cases = [
  ["chatgpt-web/medium", "medium"],
  ["chatgpt-web/high", "medium"],
  ["chatgpt-web/pro", "medium"],
  ["chatgpt-web/medium", "auto"],
];
writeFileSync(join(root, "plan.json"), JSON.stringify(cases), { mode: 0o600 });
const results: unknown[] = [];
console.log(JSON.stringify({ event: "STAGING_COMPARISON_START", root, count: cases.length }));
for (const [index, [model, staging]] of cases.entries()) {
  if (index > 0) await new Promise(resolve => setTimeout(resolve, 60_000));
  console.log(JSON.stringify({ event: "CASE_START", index, model, staging }));
  const child = Bun.spawn([process.execPath, "run", "scripts/smoke-live-review.ts", "recall", "40000", model!, "words", staging!], {
    env: { ...process.env, CGW_LIVE_FIXTURE: fixturePath }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(root, `${index}.log`), stdout + stderr, { mode: 0o600 });
  const line = stdout.split("\n").find(text => text.startsWith('{"event":"LIVE_REVIEW_RESULT"'));
  const summary = line ? JSON.parse(line) : { error: { message: stderr.slice(-2_000) } };
  results.push({ index, model, staging, exitCode, summary });
  writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "CASE_END", index, exitCode, hits: summary.score?.recalled, passed: summary.passed,
    tokens: summary.compiled?.inputTokens, root: summary.root, error: summary.error }));
  if (summary.status === 429 || summary.error?.code === "rate_limit_exceeded"
    || summary.outcome === "request_error" || summary.outcome === "operational_error" || summary.outcome === "transport_incomplete") {
    console.log(JSON.stringify({ event: "COMPARISON_STOPPED", index }));
    break;
  }
}
console.log(JSON.stringify({ event: "STAGING_COMPARISON_END", root }));
