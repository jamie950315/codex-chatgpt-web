import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("live research rejects regular/Work mode before loading runtime configuration", () => {
  const child = Bun.spawnSync([process.execPath, "run", resolve("scripts/smoke-live-review.ts"), "short"], {
    env: { ...process.env, CGW_LIVE_CHAT_MODE: "regular", CODEX_CHATGPT_WEB_HOME: "/nonexistent-live-scope-fixture" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("Only ChatGPT Temporary Chat is in scope");
});

test("live research rejects native Codex models before any request", () => {
  const child = Bun.spawnSync([process.execPath, "run", resolve("scripts/smoke-live-review.ts"), "short", "1", "gpt-6-astra"], {
    env: { ...process.env, CGW_LIVE_CHAT_MODE: "temporary", CODEX_CHATGPT_WEB_HOME: "/nonexistent-live-scope-fixture" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain("Invalid model");
});
