import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");

async function run(args: string[], env: Record<string, string> = {}): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "typecheck"]);
  if (process.platform === "win32") {
    await run([
      "test",
      "--test-name-pattern=concurrent cooldown writers|concurrent account identity writers",
      "tests/account-rotation.test.ts",
      "tests/cli.test.ts",
    ]);
    await run(["run", "test"], { CODEX_SKIP_PROCESS_CONCURRENCY_TESTS: "1" });
  } else {
    await run(["run", "test"]);
  }
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"]);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
