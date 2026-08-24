function requireCompleteShutdown(result) {
  if (result === undefined || result?.status === "stopped" || result?.status === "forced") return;
  if (result?.status === "forced-partial") {
    const failures = Array.isArray(result.failures)
      ? result.failures.filter((failure) => typeof failure === "string" && failure.trim())
      : [];
    const detail = failures.length > 0
      ? failures.join("; ")
      : typeof result.detail === "string" && result.detail.trim()
        ? result.detail.trim()
        : "local runtime cleanup did not complete";
    throw new Error(`Codex Web GPT could not fully stop its local runtime: ${detail}`);
  }
  throw new Error("Codex Web GPT received an invalid local runtime shutdown result");
}

module.exports = { requireCompleteShutdown };
