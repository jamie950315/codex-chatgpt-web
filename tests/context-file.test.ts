import { expect, test } from "bun:test";
import { acceptsChatGptFiles, assertChatGptContextFile, createChatGptContextFile } from "../src/adapters/chatgpt-web/context-file";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { resolveChatGptWebCompileOptions, estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptContextFileInputWithinLimits, chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";
import type { CodexParsedRequest } from "../src/types";

const caps = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
function request(words = 140_000, effort = "max"): CodexParsedRequest {
  return { modelId: "gpt-5.6-sol", stream: false, options: { reasoning: effort }, context: {
    systemPrompt: ["keep system priority"], messages: [
      { role: "developer", content: "keep developer priority", timestamp: 1 },
      { role: "user", content: "HEAD " + "word ".repeat(words) + " TAIL", timestamp: 2 },
    ],
  } };
}

test("large automatic Pro requests select a complete context TXT and count its content", () => {
  const parsed = request();
  const options = resolveChatGptWebCompileOptions(parsed, caps, true, "pro");
  expect(options.contextFile).toBe(true);
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, options);
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.text).not.toContain("HEAD word");
  const envelope = JSON.parse(compiled.contextFile!.content);
  expect(envelope.system).toEqual(parsed.context.systemPrompt);
  expect(envelope.messages.map((message: any) => message.role)).toEqual(["developer", "user"]);
  expect(envelope.messages[1].content).toBe(parsed.context.messages[1]!.content);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeGreaterThan(140_000);
  expect(() => assertChatGptContextFileInputWithinLimits(compiled, parsed.modelId, "max", caps)).not.toThrow();
  const files = chatGptPromptFilePayloads(compiled);
  expect(files).toHaveLength(1);
  expect(files[0]!.buffer.toString()).toBe(compiled.contextFile!.content);
  expect(files[0]!.mimeType).toBe("text/plain");
});

test("small Pro, disabled Bigger Context, and other modes keep their existing transport", () => {
  expect(resolveChatGptWebCompileOptions(request(20), caps, true, "pro").contextFile).toBeUndefined();
  expect(resolveChatGptWebCompileOptions(request(), caps, false, "pro")).toEqual({});
  expect(resolveChatGptWebCompileOptions(request(140_000, "high"), caps, true, "pro").contextFile).toBeUndefined();
  expect(() => compileChatGptWebPrompt(request(10, "medium"), caps, undefined, { contextFile: true })).toThrow("automatic ChatGPT Pro");
});

test("Pro compaction preserves original history and never trims to make a file fit", () => {
  const parsed = request(300_000);
  parsed._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, resolveChatGptWebCompileOptions(parsed, caps, true, "pro"));
  expect(compiled.contextFile!.content).toContain("HEAD");
  expect(compiled.contextFile!.content).toContain("TAIL");
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  const oversized = request(410_000);
  oversized._compactionRequest = true;
  expect(() => compileChatGptWebPrompt(oversized, caps, undefined, resolveChatGptWebCompileOptions(oversized, caps, true, "pro")))
    .toThrow("maximum 400000");
  expect(estimateChatGptWebUsage(oversized, {}, caps, true, "pro").inputTokens).toBeGreaterThan(400_000);
});

test("current native capability stays outside the context file while retired handles are redacted", () => {
  const parsed = request();
  parsed.context.systemPrompt = ["Do not reuse turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
  const toolCaps = { ...caps, localToolsEnabled: true };
  const token = "turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const compiled = compileChatGptWebPrompt(parsed, toolCaps, token, resolveChatGptWebCompileOptions(parsed, toolCaps, true, "pro"));
  expect(compiled.text).toContain(token);
  expect(compiled.contextFile!.content).not.toContain(token);
  expect(compiled.contextFile!.content).toContain("[retired turn handle]");
  expect(compiled.text).toContain("Codex Native tools");
});

test("context file integrity, mode gating and image slots fail closed", () => {
  const file = createChatGptContextFile(JSON.stringify({ version: 3, system: [], messages: [] }), 400_000);
  expect(() => assertChatGptContextFile({ ...file, content: file.content + " " })).toThrow();
  expect(() => assertChatGptContextFile({ ...file, name: "../../secret.txt" })).toThrow();
  expect(() => assertChatGptContextFile({ ...file, maxInputTokens: 1_000_000 })).toThrow();
  expect(() => assertChatGptContextFileInputWithinLimits({ text: "read", images: [], contextFile: file }, "gpt-5.6-sol", "high", caps)).toThrow();
  const parsed = request();
  parsed.context.messages.push({ role: "user", timestamp: 3, content: Array.from({ length: 10 }, () => ({ type: "image" as const, imageUrl: "data:image/jpeg;base64,YQ==" })) });
  expect(() => compileChatGptWebPrompt(parsed, caps, undefined, { contextFile: true })).toThrow("at most nine images");
});

test("file picker must accept TXT and every accompanying image", () => {
  const files = [{ name: "context.txt", mimeType: "text/plain" }, { name: "picture.png", mimeType: "image/png" }];
  expect(acceptsChatGptFiles("image/*", files)).toBe(false);
  expect(acceptsChatGptFiles(".txt", files)).toBe(false);
  expect(acceptsChatGptFiles("text/plain,image/*", files)).toBe(true);
  expect(acceptsChatGptFiles("", files)).toBe(true);
});
