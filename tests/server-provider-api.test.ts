import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";

const apiKey = "provider_api_test_key_0123456789abcdefghijklmnopqrstuvwxyz";
const providerRoots: string[] = [];

afterEach(() => {
  for (const root of providerRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function providerConfig() {
  const config = defaultConfig("browser-only");
  const root = mkdtempSync(join(tmpdir(), "codex-web-gpt-provider-response-"));
  providerRoots.push(root);
  const apiKeyFile = join(root, "provider-api.key");
  writeFileSync(apiKeyFile, `${apiKey}\n`, { mode: 0o600 });
  config.providerApi = { enabled: true, apiKeyFile };
  return config;
}

function cockpitRequest(model = "chatgpt-web/high", authorization = `Bearer ${apiKey}`) {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
      "x-client-request-id": "cockpit-provider-test",
      "x-agtools-provider-id": "chatgpt-web",
    },
    body: JSON.stringify({
      model,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with OK" }],
      }],
      instructions: "",
      store: false,
      stream: false,
      max_output_tokens: 256,
      metadata: { agtools_source: "codex_model_provider_batch_test" },
    }),
  });
}

test("provider Responses requires the exact configured Bearer key before constructing an adapter", async () => {
  let adapters = 0;
  for (const authorization of ["", "Bearer wrong-provider-key"]) {
    const response = await responseRequest(
      cockpitRequest("chatgpt-web/high", authorization),
      providerConfig(),
      () => {
        adapters += 1;
        throw new Error("unauthorized request must not construct an adapter");
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  }
  expect(adapters).toBe(0);
});

test("provider Responses rejects unknown models without native Codex passthrough", async () => {
  let adapters = 0;
  const response = await responseRequest(
    cockpitRequest("gpt-5.6-sol"),
    providerConfig(),
    () => {
      adapters += 1;
      throw new Error("unknown provider model must not construct an adapter");
    },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { type: "invalid_request_error" },
  });
  expect(adapters).toBe(0);
});

test("provider Responses accepts the Cockpit non-stream request contract", async () => {
  let observed: Record<string, unknown> | undefined;
  const response = await responseRequest(cockpitRequest(), providerConfig(), () => ({
    name: "cockpit-provider-contract",
    async runTurn(parsed, _incoming, emit) {
      observed = {
        identity: extractChatGptTurnIdentity(parsed),
        environment: extractChatGptTurnEnvironment(parsed),
        revision: extractChatGptTurnUserRevision(parsed),
        tools: parsed.context.tools ?? [],
      };
      emit({ type: "text_delta", text: "OK", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    model: "chatgpt-web/high",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
  });
  expect(observed).toMatchObject({
    identity: { threadId: expect.stringMatching(/^provider-test-/), turnId: expect.stringMatching(/^provider-test-/) },
    environment: { sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] },
    tools: [],
  });
});

test("Provider compatibility metadata cannot grant tools or activate on ordinary requests", async () => {
  for (const mutation of [
    (body: any) => { body.tools = [{ type: "function", name: "shell", parameters: {} }]; },
    (body: any) => { body.metadata.agtools_source = "anything_else"; },
  ]) {
    const request = cockpitRequest();
    const body = await request.json() as any;
    mutation(body);
    const response = await responseRequest(new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    }), providerConfig(), () => ({
      name: "must-not-run",
      async runTurn() { throw new Error("must not run"); },
    }));
    expect(response.status).toBe(400);
  }
});
