const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let shutdownFailureMessage;
try {
  ({ shutdownFailureMessage } = require("../electron/shutdown-result.cjs"));
} catch {}

test("forced partial shutdown exposes every cleanup failure before the launcher exits", () => {
  assert.equal(typeof shutdownFailureMessage, "function");
  assert.equal(
    shutdownFailureMessage({
      status: "forced-partial",
      detail: "graceful shutdown timed out",
      failures: ["tunnel: still running", "daemon: permission denied"],
    }),
    "Codex Web GPT could not fully stop its local runtime: tunnel: still running; daemon: permission denied",
  );
});

test("complete graceful and forced shutdown results permit normal launcher exit", () => {
  assert.equal(shutdownFailureMessage({ status: "stopped" }), null);
  assert.equal(shutdownFailureMessage({ status: "forced", detail: "graceful shutdown timed out" }), null);
});

test("requestQuit rejects a partial forced shutdown before committing application exit", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const requestQuit = source.slice(source.indexOf("async function requestQuit()"), source.indexOf("async function start()"));
  assert.match(requestQuit, /const shutdown = await runtimeSupervisor\?\.shutdown/);
  assert.match(requestQuit, /shutdownFailureMessage\(shutdown\)/);
  assert.match(requestQuit, /throw new Error\(shutdownFailure\)/);
  assert.ok(
    requestQuit.indexOf("throw new Error(shutdownFailure)") < requestQuit.indexOf("exitCommitted = true"),
    "partial shutdown must fail before normal exit is committed",
  );
});
