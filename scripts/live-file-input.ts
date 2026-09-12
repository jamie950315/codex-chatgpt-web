export interface LiveFileInput {
  index: number;
  testId: string | null;
  accept: string;
}

export function chooseLiveTextFileInput(inputs: LiveFileInput[]): LiveFileInput | undefined {
  const allowed = inputs.filter(input => {
    if (!Number.isSafeInteger(input.index) || input.index < 0) return false;
    const accept = input.accept.trim().toLowerCase();
    if (!accept) return true;
    return accept.split(",").map(value => value.trim())
      .some(value => ["*", "*/*", ".txt", "text/plain", "text/*"].includes(value));
  });
  return allowed.find(input => input.testId === "upload-files-input") ?? allowed[0];
}
