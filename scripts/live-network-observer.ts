import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import type { Page, Request, Response } from "playwright-core";

const hash = (value: unknown) => typeof value === "string"
  ? createHash("sha256").update(value).digest("hex") : undefined;
const modelValue = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(value) ? value : undefined;
const object = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;

export function summarizeLiveRequest(value: unknown, expected: string[]) {
  const body = object(value) ?? {};
  return {
    keys: Object.keys(body), model: modelValue(body.model), action: modelValue(body.action),
    reasoningEffort: modelValue(body.reasoning_effort), thinkingEffort: modelValue(body.thinking_effort),
    systemHints: Array.isArray(body.system_hints) ? body.system_hints.map(modelValue).filter(Boolean) : undefined,
    conversationHash: hash(body.conversation_id), parentHash: hash(body.parent_message_id),
    messages: Array.isArray(body.messages) ? body.messages.map((message: any) => {
      const parts = message?.content?.parts;
      const text = Array.isArray(parts) ? parts.filter((part: unknown) => typeof part === "string").join("\n") : "";
      return { idHash: hash(message.id), role: modelValue(message.author?.role), chars: text.length, textHash: hash(text),
        expectedPart: expected.findIndex(part => part === text) + 1,
        checkpointTokens: [...text.matchAll(/\bR\d{2}(?:HEAD|MID|TAIL)[A-F0-9]{12}\b/g)].map(match => match[0]),
      };
    }) : [],
  };
}

export function summarizeLiveResponse(value: unknown) {
  const body = object(value) ?? {};
  const message = object(body.message) ?? object(object(body.v)?.message);
  const metadata = object(message?.metadata) ?? {};
  const deltaPath = typeof body.p === "string" && /\/(?:model_slug|default_model_slug|reasoning_effort)$/.test(body.p) ? body.p : undefined;
  return { conversationHash: hash(body.conversation_id), messageHash: hash(message?.id), parentHash: hash(body.parent_message_id),
    role: modelValue(message?.author?.role), channel: modelValue(message?.channel),
    model: modelValue(metadata.model_slug), defaultModel: modelValue(metadata.default_model_slug),
    reasoningEffort: modelValue(metadata.reasoning_effort), thinkingEffort: modelValue(metadata.thinking_effort),
    metadataParentHash: hash(metadata.parent_id), status: modelValue(message?.status),
    metadataKeys: Object.keys(metadata), deltaPath, deltaValue: deltaPath ? modelValue(body.v) : undefined,
  };
}

// Passive observation of the leased synthetic-test page only. No headers, cookies, raw text or thoughts.
export function attachLiveNetworkObserver(page: Page, path: string, expected: string[]): () => Promise<void> {
  writeFileSync(path, "", { mode: 0o600 });
  const write = (event: Record<string, unknown>) => appendFileSync(path, JSON.stringify({ at: Date.now(), ...event }) + "\n");
  write({ event: "expected_messages", messages: expected.map((text, index) => ({ part: index + 1, chars: text.length, textHash: hash(text) })) });
  let requestIndex = 0;
  const requests = new Map<Request, number>();
  const pending = new Set<Promise<void>>();
  const relevant = (request: Request) => {
    const url = new URL(request.url());
    return url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/")
      && url.pathname.includes("conversation") && request.method() === "POST";
  };
  const onRequest = (request: Request) => {
    if (!relevant(request)) return;
    const index = ++requestIndex;
    requests.set(request, index);
    try {
      write({ event: "request", index, endpoint: new URL(request.url()).pathname, ...summarizeLiveRequest(request.postDataJSON(), expected) });
    } catch { write({ event: "request_unreadable", index }); }
  };
  const onResponse = (response: Response) => {
    const index = requests.get(response.request());
    if (index === undefined) return;
    const task = (async () => {
      write({ event: "response_status", index, status: response.status() });
      try {
        const text = await response.text();
        let values: unknown[];
        try { values = [JSON.parse(text)]; }
        catch { values = text.split("\n").filter(line => line.startsWith("data: ")).flatMap(line => {
          try { return [JSON.parse(line.slice(6))]; } catch { return []; }
        }); }
        const seen = new Set<string>();
        for (const value of values) {
          const safe = summarizeLiveResponse(value);
          if (!safe.conversationHash && !safe.messageHash && !safe.deltaPath) continue;
          const encoded = JSON.stringify(safe);
          if (seen.has(encoded)) continue;
          seen.add(encoded);
          write({ event: "response_metadata", index, ...safe });
        }
        write({ event: "response_end", index, bytes: Buffer.byteLength(text), frames: values.length });
      } catch { write({ event: "response_body_unavailable", index }); }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return async () => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { timer = setTimeout(resolve, 5_000); })]);
    clearTimeout(timer);
    write({ event: "observer_end", pending: pending.size });
  };
}
