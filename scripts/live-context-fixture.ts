import { randomBytes } from "node:crypto";
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
