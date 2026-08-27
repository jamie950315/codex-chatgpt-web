const test = require("node:test");
const assert = require("node:assert/strict");
const { runtimeStartupPolicy } = require("../electron/startup-policy.cjs");

test("Provider startup bypasses Codex route inspection and never restores that route", () => {
  assert.deepEqual(runtimeStartupPolicy({ providerApi: { enabled: true } }), {
    inspectRoute: false,
    restoreRouteOnFailure: false,
  });
});

test("managed startup keeps the Codex route fail-closed policy", () => {
  assert.deepEqual(runtimeStartupPolicy({}), {
    inspectRoute: true,
    restoreRouteOnFailure: true,
  });
});
