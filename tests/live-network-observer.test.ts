import { expect, test } from "bun:test";
import { summarizeLiveRequest, summarizeLiveResponse } from "../scripts/live-network-observer";

test("network evidence records exact synthetic payload identity without credentials", () => {
  const text = "R01HEADABCDEF123456 fixture";
  const summary = summarizeLiveRequest({ access_token: "DO_NOT_SAVE", parent_message_id: "parent-raw", model: "test-model",
    messages: [{ id: "raw-id", author: { role: "user" }, content: { parts: [text] } }] }, [text]);
  expect(summary.messages[0].expectedPart).toBe(1);
  expect(summary.messages[0].checkpointTokens).toEqual(["R01HEADABCDEF123456"]);
  expect(JSON.stringify(summary)).not.toContain("DO_NOT_SAVE");
  expect(JSON.stringify(summary)).not.toContain("parent-raw");
});

test("response evidence discards thought and answer text", () => {
  const summary = summarizeLiveResponse({ conversation_id: "raw-conversation", message: { id: "raw-message", channel: "analysis",
    content: { parts: ["PRIVATE THOUGHT DO_NOT_SAVE"] }, metadata: { model_slug: "test-model", access_token: "DO_NOT_SAVE" } } });
  expect(summary.model).toBe("test-model");
  expect(JSON.stringify(summary)).not.toContain("DO_NOT_SAVE");
  expect(JSON.stringify(summary)).not.toContain("PRIVATE THOUGHT");
  expect(JSON.stringify(summary)).not.toContain("raw-conversation");
});

test("network observation recognizes tool recipients in direct and delta messages", () => {
  expect(summarizeLiveResponse({ v: { id: "fixture-id", author: { role: "assistant" }, recipient: "file_search.msearch" } }).recipient)
    .toBe("file_search.msearch");
  expect(summarizeLiveResponse({ p: "/message/recipient", v: "python" }).deltaValue).toBe("python");
});
