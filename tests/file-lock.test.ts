import { expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationLock } from "../src/file-lock";

test("an abandoned recovery lock does not permanently block future writers", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-file-lock-${process.pid}-${Date.now()}`);
  const lockPath = join(root, "config.lock");
  const recoveryPath = `${lockPath}.recovery`;
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(recoveryPath, "99999999-abandoned\n", { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    utimesSync(recoveryPath, stale, stale);

    expect(withFileMutationLock(lockPath, "lock timeout", () => "updated")).toBe("updated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
