const test = require("node:test");
const assert = require("node:assert/strict");

let requireCompleteShutdown;
try {
  ({ requireCompleteShutdown } = require("../electron/shutdown-result.cjs"));
} catch {}

test("partial forced shutdown rejects exit with every cleanup failure", () => {
  assert.equal(typeof requireCompleteShutdown, "function");
  assert.throws(
    () => requireCompleteShutdown({
      status: "forced-partial",
      detail: "graceful shutdown timed out",
      failures: ["tunnel: still running", "daemon: permission denied"],
    }),
    {
      message: "Codex Web GPT could not fully stop its local runtime: tunnel: still running; daemon: permission denied",
    },
  );
});

test("complete graceful and forced shutdown results permit exit", () => {
  assert.doesNotThrow(() => requireCompleteShutdown({ status: "stopped" }));
  assert.doesNotThrow(() => requireCompleteShutdown({ status: "forced" }));
  assert.doesNotThrow(() => requireCompleteShutdown(undefined));
});
