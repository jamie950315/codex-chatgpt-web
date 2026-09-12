import { expect, test } from "bun:test";
import { makeLiveContextFixture, validateLiveContextFixture, scoreLiveContextOutput, extractLiveContextAnswer, liveDiagnosticEvidence } from "../scripts/live-context-fixture";
import { SUMMARY_PREFIX, encodeCompactionSummary } from "../src/responses/compaction";

test("live context fixtures put unique independent checkpoints across all records", () => {
  for (const kind of ["words", "code", "chinese"] as const) {
    const fixture = makeLiveContextFixture(kind, 100);
    expect(fixture.content).toHaveLength(8);
    expect(new Set(fixture.expected.map(item => item.marker)).size).toBe(24);
    for (const item of fixture.expected) expect(fixture.content[item.record - 1]).toContain(item.marker);
    expect(scoreLiveContextOutput(fixture.expected.map(item => item.marker).join("\n"), fixture.expected).complete).toBe(true);
    const truncated = scoreLiveContextOutput(fixture.expected.slice(3).map(item => item.marker).join("\n"), fixture.expected);
    expect(truncated.complete).toBe(false);
    expect(truncated.missing.map(item => item.record)).toEqual([1, 1, 1]);
  }
});

test("matched experiments reuse identical valid data and reject corrupted checkpoints", () => {
  const fixture = makeLiveContextFixture("words", 100);
  expect(validateLiveContextFixture(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
  const corrupted = structuredClone(fixture);
  corrupted.expected[0]!.marker = "word";
  expect(() => validateLiveContextFixture(corrupted)).toThrow("Invalid matched checkpoint");
});

test("live compaction grading never counts echoed input as newly recalled data", () => {
  const echoed = { type: "message", content: [{ text: "SECRET_CHECKPOINT" }] };
  expect(extractLiveContextAnswer({ output: [echoed] }, true)).toBe("");
  expect(extractLiveContextAnswer({ output: [echoed, { content: [{ text: SUMMARY_PREFIX + "\nNo checkpoint visible" }] }] }, true))
    .toBe("No checkpoint visible");
  expect(extractLiveContextAnswer({ output: [echoed, { encrypted_content: encodeCompactionSummary("fresh summary") }] }, true))
    .toBe("fresh summary");
});

test("diagnostic grading ignores screenshot duplicates", () => {
  expect(liveDiagnosticEvidence([
    "12-multipart-stage-1-acknowledged.json", "12-multipart-stage-1-acknowledged.png",
    "13-multipart-stage-1-acknowledged.json", "15-multipart-stage-2-acknowledged.json", "29-turn-completed.json",
  ])).toEqual({ ackCount: 2, turnCompleted: true });
});
