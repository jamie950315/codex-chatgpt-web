import { randomBytes, randomInt } from "node:crypto";
import { estimateTokens } from "../src/lib/token-estimate";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";

export type FixtureKind = "words" | "code" | "chinese";

function padding(kind: FixtureKind, tokens: number, record: number): string {
  if (kind === "words") return "word ".repeat(tokens);
  let source = "";
  for (let i = 0; source.length < tokens * 7; i++) {
    source += kind === "code"
      ? `export const row${record}_${i} = { state: "ready", retry: ${i % 7}, cache: false }; // synthetic fixture\n`
      : `第${record}組第${i}筆測試資料：此紀錄描述一般工作流程，先檢查輸入，再更新狀態，最後確認結果；它不包含檢查點。\n`;
  }
  let low = 0, high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(source.slice(0, mid)) <= tokens) low = mid;
    else high = mid - 1;
  }
  return source.slice(0, low);
}

export function makeLiveContextFixture(kind: FixtureKind, tokensPerRecord: number, records = 8) {
  const expected: Array<{ record: number; position: string; marker: string }> = [];
  const content = Array.from({ length: records }, (_, index) => {
    const record = index + 1;
    const text = padding(kind, tokensPerRecord, record);
    const markers = ["HEAD", "MID", "TAIL"].map(position => {
      const marker = `R${String(record).padStart(2, "0")}${position}${randomBytes(6).toString("hex").toUpperCase()}`;
      expected.push({ record, position, marker });
      return `\nImportant checkpoint token: ${marker}\n`;
    });
    const middle = Math.floor(text.length / 2);
    return `Record ${record}. Preserve its three checkpoint tokens exactly.\n`
      + markers[0] + text.slice(0, middle) + markers[1] + text.slice(middle) + markers[2];
  });
  return { content, expected, payloadTokens: content.reduce((n, text) => n + estimateTokens(text), 0) };
}

export function scoreLiveContextOutput(output: string, expected: ReturnType<typeof makeLiveContextFixture>["expected"]) {
  const missing = expected.filter(checkpoint => !output.includes(checkpoint.marker));
  return { recalled: expected.length - missing.length, total: expected.length, missing, complete: missing.length === 0 };
}

export function validateLiveContextFixture(value: unknown): ReturnType<typeof makeLiveContextFixture> {
  const candidate = value as ReturnType<typeof makeLiveContextFixture> | null;
  if (!candidate || !Array.isArray(candidate.content) || candidate.content.length !== 8
    || candidate.content.some(text => typeof text !== "string") || !Array.isArray(candidate.expected)
    || candidate.expected.length !== 24 || new Set(candidate.expected.map(item => item.marker)).size !== 24) {
    throw new Error("Invalid matched live context fixture");
  }
  for (const [index, item] of candidate.expected.entries()) {
    const record = Math.floor(index / 3) + 1;
    const position = ["HEAD", "MID", "TAIL"][index % 3];
    const prefix = `R${String(record).padStart(2, "0")}${position}`;
    if (item.record !== record || item.position !== position
      || !new RegExp(`^${prefix}[A-F0-9]{12}$`).test(item.marker)
      || !candidate.content[record - 1]!.includes(item.marker)) throw new Error("Invalid matched checkpoint");
  }
  return { ...candidate, payloadTokens: candidate.content.reduce((sum, text) => sum + estimateTokens(text), 0) };
}

export function selectLiveContextRecords(fixture: ReturnType<typeof makeLiveContextFixture>, start: number, end: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 8 || start > end) throw new Error("Invalid record range");
  const content = fixture.content.slice(start - 1, end);
  return { content, expected: fixture.expected.filter(item => item.record >= start && item.record <= end),
    payloadTokens: content.reduce((sum, text) => sum + estimateTokens(text), 0) };
}

export interface LiveChainNode { id: string; next: string; seal: string }

export function makeLiveLinkedFixture(fixture: ReturnType<typeof makeLiveContextFixture>) {
  const order = fixture.expected.map(item => item.marker);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const chain: LiveChainNode[] = order.map((id, i) => ({ id, next: order[i + 1] ?? "END", seal: randomBytes(8).toString("hex").toUpperCase() }));
  const byId = new Map(chain.map(node => [node.id, node]));
  const content = fixture.content.map(text => text.replace(/Important checkpoint token: (R\d{2}(?:HEAD|MID|TAIL)[A-F0-9]{12})/g,
    (_match, id: string) => `const ${id} = ${JSON.stringify(byId.get(id))};`));
  return { ...fixture, content, chain, payloadTokens: content.reduce((sum, text) => sum + estimateTokens(text), 0) };
}

export function scoreLiveChain(output: string, expected: LiveChainNode[]) {
  // ChatGPT's DOM-to-Markdown serializer escapes outer JSON brackets outside code fences.
  // The fixture's ids/seals are alphanumeric, so this cannot change an expected field value.
  const rendered = output.replace(/\\([\[\]])/g, "$1");
  const array = rendered.match(/\[\s*\{[\s\S]*\}\s*\]/)?.[0];
  let actual: any[] = [];
  try { const parsed = JSON.parse(array ?? "null"); if (Array.isArray(parsed)) actual = parsed; } catch { /* invalid answer */ }
  const matched = expected.filter((node, i) => actual[i]?.id === node.id && actual[i]?.seal === node.seal).length;
  return { complete: actual.length === expected.length && matched === expected.length, matched, total: expected.length, actualCount: actual.length };
}

export function extractLiveContextAnswer(result: { output?: any[] }, compaction: boolean): string {
  const items = compaction ? (result.output ?? []).slice(-1) : (result.output ?? []);
  return items.flatMap(item => {
    if (typeof item.encrypted_content === "string") return [decodeCompactionSummary(item.encrypted_content) ?? ""];
    const text = (item.content ?? []).map((part: any) => part.text ?? "").join("\n");
    if (compaction) return text.startsWith(SUMMARY_PREFIX) ? [text.slice(SUMMARY_PREFIX.length).trim()] : [];
    return [text];
  }).join("\n");
}

export function liveDiagnosticEvidence(files: string[]) {
  const json = files.filter(name => name.endsWith(".json"));
  const stages = new Set(json.flatMap(name => {
    const stage = name.match(/multipart-stage-(\d+)-acknowledged/);
    return stage ? [Number(stage[1])] : [];
  }));
  return { ackCount: stages.size, turnCompleted: json.some(name => /turn-completed/.test(name)) };
}
