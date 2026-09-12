import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { decodeCompactionSummary } from "../src/responses/compaction";

// Live, opt-in tests only: synthetic inputs, existing authenticated browser, isolated state.
const scenario = process.argv[2] ?? "short";
if (!["short", "compaction"].includes(scenario)) throw new Error("Expected short or compaction");
const wordsPerRecord = Number(process.argv[3] ?? 40_000);
if (!Number.isInteger(wordsPerRecord) || wordsPerRecord < 1 || wordsPerRecord > 50_000) throw new Error("Invalid record size");
const model = process.argv[4] ?? (scenario === "short" ? "chatgpt-web/light" : "chatgpt-web/medium");
if (!["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/pro"].includes(model)) throw new Error("Invalid model");
const installed = loadConfig();
const root = resolve("runtime", `live-review-${scenario}-${Date.now()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
process.env.CODEX_CHATGPT_WEB_HOME = root;
const helper = resolve("launcher/build/runtime/app/browser-helper.cjs");
const helperHash = createHash("sha256").update(readFileSync(helper)).digest("hex");
const server = startServer({
  ...installed, mode: "browser-only", host: "127.0.0.1", port: 0,
  nativePassthrough: undefined, brokerSocketPath: join(root, "broker.sock"),
}, {
  adapterFactory(provider) {
    provider.chatgptWeb = {
      ...provider.chatgptWeb!, browserHelperScriptPath: helper,
      browserDiagnosticsPath: join(root, "browser-turns"), turnTimeoutMs: 600_000,
    };
    return createChatGptWebAdapter(provider);
  },
});
const threadId = randomUUID(), turnId = randomUUID();
const metadata = { thread_id: threadId, turn_id: turnId };
const envelope = `<environment_context>\n<cwd>${process.cwd()}</cwd>\n<approval_policy>never</approval_policy>\n<sandbox_mode>read-only</sandbox_mode>\n</environment_context>`;
const message = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId } });
const markers = ["EARLYCEDAR572", "MIDDLEORBIT864", "LASTMAPLE391"];
const input = scenario === "short" ? [message(envelope), message("Return exactly WEBGPTLIVEPONG. Do not use tools.")]
  : [
    ...Array.from({ length: 8 }, (_, i) => message(
      `Record ${i + 1}. Important retained project fact: ${markers[i === 0 ? 0 : i === 4 ? 1 : 2]}. `
      + "word ".repeat(wordsPerRecord),
    )),
    message(envelope),
    message("The next stage must retain all three distinct project fact markers from these records. Summarize them verbatim, including the earliest record. Do not use tools."),
  ];
const body = { model, stream: false,
  client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) }, input };
writeFileSync(join(root, "request.json"), JSON.stringify(body), { mode: 0o600 });
console.log(JSON.stringify({ event: "LIVE_REVIEW_START", scenario, root, helperHash, threadId, turnId, port: server.port }));
const started = Date.now();
try {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses${scenario === "compaction" ? "/compact" : ""}`, {
    method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify(metadata) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(660_000),
  });
  const result = await response.json() as any;
  writeFileSync(join(root, "response.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  // v1 compact responses also echo original user messages; only the new summary proves recall.
  const resultItems = scenario === "compaction" ? (result.output ?? []).slice(-1) : (result.output ?? []);
  const output = resultItems.flatMap((item: any) => {
    if (typeof item.encrypted_content === "string") return [decodeCompactionSummary(item.encrypted_content) ?? ""];
    return (item.content ?? []).map((part: any) => part.text ?? "");
  }).join("\n");
  const expected = scenario === "short" ? ["WEBGPTLIVEPONG"] : markers;
  const passed = response.ok && expected.every(marker => output.includes(marker));
  const summary = { event: "LIVE_REVIEW_RESULT", scenario, model, wordsPerRecord, passed, status: response.status,
    elapsedMs: Date.now() - started, output, error: result.error, root, helperHash };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
  if (!passed) process.exitCode = 1;
} finally {
  await closeChatGptBrowserWorkers();
  await server.stop(true);
}
