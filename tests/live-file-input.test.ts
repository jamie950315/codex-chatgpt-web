import { expect, test } from "bun:test";
import { chooseLiveTextFileInput } from "../scripts/live-file-input";

test("file probes select a text-capable picker and never force text into an image-only picker", () => {
  expect(chooseLiveTextFileInput([{ index: 0, testId: "upload-photos-input", accept: "image/*" }])).toBeUndefined();
  expect(chooseLiveTextFileInput([
    { index: 0, testId: "upload-photos-input", accept: "image/*" },
    { index: 1, testId: null, accept: "" },
  ])?.index).toBe(1);
  expect(chooseLiveTextFileInput([
    { index: 0, testId: null, accept: "" },
    { index: 1, testId: "upload-files-input", accept: ".PDF, .TXT" },
  ])?.index).toBe(1);
});
