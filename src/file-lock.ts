import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function ownerPid(token: string): number | undefined {
  const match = /^(\d+)-/.exec(token.trim());
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function removeIfOwned(path: string, token: string): void {
  try {
    if (readFileSync(path, "utf8").trim() === token) rmSync(path, { force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function recoverAbandonedRecoveryLock(recoveryPath: string): void {
  try {
    if (Date.now() - statSync(recoveryPath).mtimeMs < LOCK_STALE_MS) return;
    const token = readFileSync(recoveryPath, "utf8").trim();
    const pid = ownerPid(token);
    if (pid !== undefined && processIsAlive(pid)) return;
    rmSync(recoveryPath, { force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function recoverStaleLock(lockPath: string): void {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryToken = `${process.pid}-${randomBytes(16).toString("hex")}`;
  let recoveryFd: number | undefined;
  try {
    recoveryFd = openSync(recoveryPath, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return;
    throw error;
  }
  try {
    writeFileSync(recoveryFd, `${recoveryToken}\n`);
  } catch (error) {
    closeSync(recoveryFd);
    recoveryFd = undefined;
    rmSync(recoveryPath, { force: true });
    throw error;
  }
  try {
    let modifiedAt: number;
    try {
      modifiedAt = statSync(lockPath).mtimeMs;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (Date.now() - modifiedAt < LOCK_STALE_MS) return;
    let token = "";
    try {
      token = readFileSync(lockPath, "utf8").trim();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    const pid = ownerPid(token);
    if (pid !== undefined && processIsAlive(pid)) return;
    rmSync(lockPath, { force: true });
  } finally {
    if (recoveryFd !== undefined) closeSync(recoveryFd);
    removeIfOwned(recoveryPath, recoveryToken);
  }
}

export function withFileMutationLock<T>(
  lockPath: string,
  timeoutMessage: string,
  action: () => T,
): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const recoveryPath = `${lockPath}.recovery`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = `${process.pid}-${randomBytes(16).toString("hex")}`;
  let lockFd: number | undefined;
  for (;;) {
    if (existsSync(recoveryPath)) {
      recoverAbandonedRecoveryLock(recoveryPath);
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      Atomics.wait(lockSleep, 0, 0, 10);
      continue;
    }
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(lockFd, `${token}\n`);
      } catch (error) {
        closeSync(lockFd);
        lockFd = undefined;
        rmSync(lockPath, { force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      recoverStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      Atomics.wait(lockSleep, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    removeIfOwned(lockPath, token);
  }
}
