import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { makeLiveContextFixture, validateLiveContextFixture, selectLiveContextRecords, scoreLiveContextOutput, extractLiveContextAnswer, liveDiagnosticEvidence, type FixtureKind } from "./live-context-fixture";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateTokens } from "../src/lib/token-estimate";
import { resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";

// Live, opt-in tests only: synthetic inputs, existing authenticated browser, isolated state.
const scenario = process.argv[2] ?? "short";
if (!["short", "compaction", "recall"].includes(scenario)) throw new Error("Expected short, compaction or recall");
const wordsPerRecord = Number(process.argv[3] ?? 40_000);
if (!Number.isInteger(wordsPerRecord) || wordsPerRecord < 1 || wordsPerRecord > 50_000) throw new Error("Invalid record size");
const model = process.argv[4] ?? (scenario === "short" ? "chatgpt-web/light" : "chatgpt-web/medium");
if (!["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/pro"].includes(model)) throw new Error("Invalid model");
const kind = (process.argv[5] ?? "words") as FixtureKind;
if (!["words", "code", "chinese"].includes(kind)) throw new Error("Invalid fixture kind");
const stagingPolicy = process.argv[6] ?? "auto";
if (!["auto", "medium", "max"].includes(stagingPolicy)) throw new Error("Invalid staging policy");
const installed = loadConfig();
const root = resolve("runtime", `live-review-${scenario}-${Date.now()}-${randomUUID().slice(0, 8)}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
process.env.CODEX_CHATGPT_WEB_HOME = root;
let helper = resolve("launcher/build/runtime/app/browser-helper.cjs");
if (stagingPolicy !== "auto" || process.env.CGW_LIVE_NETWORK_TRACE === "1") {
  // Experimental control, not a production change: vary only staging effort in an isolated build.
  const workerPath = resolve("src/adapters/chatgpt-web/browser-worker.ts");
  const original = readFileSync(workerPath, "utf8");
  const needle = 'const efforts: readonly ChatGptWebModelMode["effort"][] = capabilities.proAvailable\n    ? ["low", "medium", "max"]\n    : ["low", "medium"];';
  if (original.split(needle).length !== 2) throw new Error("Staging experiment source no longer matches");
  let variant = stagingPolicy === "auto" ? original
    : original.replace(needle, `const efforts: readonly ChatGptWebModelMode["effort"][] = [${JSON.stringify(stagingPolicy)}];`);
  if (process.env.CGW_LIVE_NETWORK_TRACE === "1") {
    const points = ["\n    let diagnosticPage: Page | undefined;\n", "\n      diagnosticPage = page;\n", "\n      prepared.release();\n"];
    if (points.some(point => variant.split(point).length !== 2)) throw new Error("Network observer injection points changed");
    variant = `import { attachLiveNetworkObserver } from ${JSON.stringify(resolve("scripts/live-network-observer.ts"))};\n` + variant;
    variant = variant.replace(points[0]!, points[0] + "\n    let stopLiveObserver: (() => Promise<void>) | undefined;");
    variant = variant.replace(points[1]!, points[1] + `\n      stopLiveObserver = attachLiveNetworkObserver(page, ${JSON.stringify(join(root, "network.jsonl"))}, [...(multipartStages ?? []).map(stage => stage.text), multipartFinalPrompt ?? prepared.text]);`);
    variant = variant.replace(points[2]!, "      await stopLiveObserver?.();\n" + points[2]);
  }
  writeFileSync(join(root, "variant-browser-worker.ts"), variant, { mode: 0o600 });
  const build = await Bun.build({ entrypoints: [resolve("src/adapters/chatgpt-web/browser-helper-main.ts")],
    target: "node", format: "cjs", minify: true, packages: "external", external: ["playwright-core"],
    outdir: root, naming: "browser-helper.cjs", plugins: [{ name: "isolated-staging-control", setup(builder) {
      builder.onLoad({ filter: /browser-worker\.ts$/ }, args => args.path === workerPath
        ? { contents: variant, loader: "ts" } : undefined);
    } }],
  });
  if (!build.success) throw new Error(build.logs.map(log => log.message).join("\n"));
  helper = join(root, "browser-helper.cjs");
}
const helperHash = createHash("sha256").update(readFileSync(helper)).digest("hex");
let fixture = process.env.CGW_LIVE_FIXTURE
  ? validateLiveContextFixture(JSON.parse(readFileSync(process.env.CGW_LIVE_FIXTURE, "utf8")))
  : makeLiveContextFixture(kind, scenario === "short" ? 1 : wordsPerRecord);
if (process.env.CGW_LIVE_RECORD_RANGE) {
  const range = process.env.CGW_LIVE_RECORD_RANGE.split(":").map(Number);
  if (range.length !== 2) throw new Error("Invalid record range");
  fixture = selectLiveContextRecords(fixture, range[0]!, range[1]!);
}
const fixtureHash = createHash("sha256").update(JSON.stringify(fixture.content)).digest("hex");
let compiledEvidence: Record<string, unknown> = {};
const server = startServer({
  ...installed, mode: "browser-only", host: "127.0.0.1", port: 0,
  nativePassthrough: undefined, brokerSocketPath: join(root, "broker.sock"),
}, {
  adapterFactory(provider) {
    provider.chatgptWeb = {
      ...provider.chatgptWeb!, browserHelperScriptPath: helper,
      browserDiagnosticsPath: join(root, "browser-turns"), turnTimeoutMs: 600_000,
    };
    const adapter = createChatGptWebAdapter(provider);
    return {
      ...adapter,
      async runTurn(parsed, incoming, emit) {
        const caps = { localToolsEnabled: false, solAvailable: installed.solAvailable, proAvailable: installed.proAvailable };
        const parts = resolveBiggerContextMultipartParts(parsed, caps);
        const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
        const messages = compiledChatGptWebMessages(compiled);
        const stageMessages = messages.slice(0, -1);
        const stageMode = parts ? resolveChatGptWebMultipartStagingMode(parsed.modelId, caps,
          Math.max(...stageMessages.map(text => estimateTokens(text))), Math.max(...stageMessages.map(text => text.length))) : undefined;
        compiledEvidence = { evidenceKind: "preflight_recompute", parts: parts ?? 1, inputTokens: estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
          messageTokens: messages.map(text => estimateTokens(text)), messageChars: messages.map(text => text.length),
          stagingEffort: stagingPolicy === "auto" ? stageMode?.effort : stagingPolicy, trimmed: compiled.trimmedCompactionMessages ?? 0,
          checkpointParts: fixture.expected.map(item => ({ ...item, part: messages.findIndex(text => text.includes(item.marker)) + 1 })) };
        writeFileSync(join(root, "compiled.json"), JSON.stringify(compiledEvidence), { mode: 0o600 });
        console.log(JSON.stringify({ event: "LIVE_REVIEW_COMPILED", ...compiledEvidence, checkpointParts: undefined }));
        return adapter.runTurn(parsed, incoming, emit);
      },
    };
  },
});
const threadId = randomUUID(), turnId = randomUUID();
const metadata = { thread_id: threadId, turn_id: turnId };
const envelope = `<environment_context>\n<cwd>${process.cwd()}</cwd>\n<approval_policy>never</approval_policy>\n<sandbox_mode>read-only</sandbox_mode>\n</environment_context>`;
const message = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId } });
const input = scenario === "short" ? [message(envelope), message("Return exactly WEBGPTLIVEPONG. Do not use tools.")]
  : [
    ...fixture.content.map(message),
    message(envelope),
    message(`Copy ALL ${fixture.expected.length} distinct checkpoint tokens from the supplied records verbatim, including HEAD, MID and TAIL from every record. These tokens are the only important facts. Preserve them in the summary if summarizing. Do not use tools. If a token is not visible, say MISSING instead of guessing. Do not omit early records.`),
  ];
const body = { model, stream: false,
  client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) }, input };
writeFileSync(join(root, "request.json"), JSON.stringify(body), { mode: 0o600 });
writeFileSync(join(root, "expected.json"), JSON.stringify(fixture.expected), { mode: 0o600 });
console.log(JSON.stringify({ event: "LIVE_REVIEW_START", scenario, kind, model, stagingPolicy, wordsPerRecord, root, helperHash, fixtureHash, threadId, turnId, port: server.port }));
const started = Date.now();
try {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses${scenario === "compaction" ? "/compact" : ""}`, {
    method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify(metadata) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(660_000),
  });
  const result = await response.json() as any;
  writeFileSync(join(root, "response.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  // v1 compact responses also echo original user messages; only the new summary proves recall.
  const output = extractLiveContextAnswer(result, scenario === "compaction");
  const score = scoreLiveContextOutput(output, fixture.expected);
  const diagnosticRoot = join(root, "browser-turns");
  const checkpoints = existsSync(diagnosticRoot) ? readdirSync(diagnosticRoot).flatMap(dir => readdirSync(join(diagnosticRoot, dir))) : [];
  const { ackCount, turnCompleted } = liveDiagnosticEvidence(checkpoints);
  const passed = response.ok && !result.error && turnCompleted && compiledEvidence.trimmed === 0
    && ackCount === Number(compiledEvidence.parts) - 1
    && (scenario === "short" ? output.includes("WEBGPTLIVEPONG") : score.complete);
  const summary = { event: "LIVE_REVIEW_RESULT", scenario, model, kind, stagingPolicy, wordsPerRecord,
    outcome: passed ? "complete" : !response.ok || result.error ? "request_error"
      : !turnCompleted || ackCount !== Number(compiledEvidence.parts) - 1 ? "transport_incomplete"
      : compiledEvidence.trimmed !== 0 ? "application_trim" : "recall_failure",
    payloadTokens: fixture.payloadTokens, payloadChars: fixture.content.reduce((n, text) => n + text.length, 0), passed, status: response.status,
    elapsedMs: Date.now() - started, output, score, ackCount, turnCompleted, compiled: compiledEvidence, error: result.error, root, helperHash, fixtureHash };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, output: undefined }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  const summary = { event: "LIVE_REVIEW_RESULT", scenario, model, kind, stagingPolicy, wordsPerRecord,
    passed: false, outcome: "operational_error", elapsedMs: Date.now() - started,
    error: { message: error instanceof Error ? error.message : String(error) }, root, helperHash };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
  process.exitCode = 1;
} finally {
  await closeChatGptBrowserWorkers();
  await server.stop(true);
}
