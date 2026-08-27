const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderController } = require("../electron/provider-controller.cjs");

test("Provider controller copies secrets directly to the system clipboard", () => {
  const writes = [];
  const status = { enabled: true, configured: true, baseUrl: "http://127.0.0.1:17841/v1", runtimeStatus: "ready" };
  const controller = createProviderController({
    clipboard: { writeText: value => writes.push(value) },
    runtimeHost: {
      providerStatus: () => status,
      readProviderKey: () => "cwg_secret_provider_key_0123456789abcdefghijk",
    },
  });
  assert.deepEqual(controller.copyKey(), status);
  assert.deepEqual(writes, ["cwg_secret_provider_key_0123456789abcdefghijk"]);
  assert.equal(JSON.stringify(controller.copyKey()).includes("secret_provider_key"), false);
});

test("Provider controller rotates into the clipboard without returning the key", () => {
  const writes = [];
  const status = { enabled: true, configured: true, baseUrl: "http://127.0.0.1:17841/v1", runtimeStatus: "ready" };
  const controller = createProviderController({
    clipboard: { writeText: value => writes.push(value) },
    runtimeHost: {
      providerStatus: () => status,
      rotateProviderKey: () => "cwg_rotated_provider_key_0123456789abcdefgh",
    },
  });
  assert.deepEqual(controller.rotateKey(), status);
  assert.deepEqual(writes, ["cwg_rotated_provider_key_0123456789abcdefgh"]);
  assert.equal(JSON.stringify(controller.rotateKey()).includes("rotated_provider_key"), false);
});

test("Provider controller returns refreshed safe status after setup", async () => {
  let enabled = false;
  const controller = createProviderController({
    clipboard: { writeText() {} },
    runtimeHost: {
      providerStatus: () => ({ enabled, configured: enabled, baseUrl: "http://127.0.0.1:17841/v1", runtimeStatus: enabled ? "ready" : "stopped" }),
      setupProvider: async () => { enabled = true; },
    },
  });
  assert.deepEqual(await controller.setup(), {
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:17841/v1",
    runtimeStatus: "ready",
  });
});
