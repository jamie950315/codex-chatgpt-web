import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

test("search and images reread sidecar credentials and contain missing-file errors", async () => {
  const originalHome = process.env.CODEX_HOME;
  const root = mkdtempSync(join(tmpdir(), "sidecar-credentials-"));
  process.env.CODEX_HOME = root;
  const tokenPath = join(root, "fixture.key");
  writeFileSync(tokenPath, "first-fixture-token", { mode: 0o600 });
  const config = {
    ...defaultConfig("browser-only"),
    port: 0,
    nativePassthrough: { baseUrl: "http://127.0.0.1:57204/v1", bearerTokenFile: tokenPath },
  };
  const seen: string[] = [];
  const beforeSigint = new Set(process.listeners("SIGINT"));
  const beforeSigterm = new Set(process.listeners("SIGTERM"));
  const server = startServer(config, {
    fetchUpstream: async request => {
      seen.push(request.headers.get("authorization") ?? "");
      return Response.json({ ok: true });
    },
  });
  const send = (path: string) => fetch(`http://127.0.0.1:${server.port}/v1/${path}`, {
    method: "POST",
    headers: { authorization: "Bearer incoming-fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ query: "fixture", prompt: "fixture" }),
  });
  try {
    const paths = ["alpha/search", "images/generations", "images/edits"];
    for (const path of paths) {
      const response = await send(path);
      expect(response.status).toBe(200);
      await response.json();
    }
    writeFileSync(tokenPath, "second-fixture-token");
    for (const path of paths) {
      const response = await send(path);
      expect(response.status).toBe(200);
      await response.json();
    }
    expect(seen).toEqual([
      ...paths.map(() => "Bearer first-fixture-token"),
      ...paths.map(() => "Bearer second-fixture-token"),
    ]);
    rmSync(tokenPath);
    for (const path of paths) {
      const response = await send(path);
      expect(response.status).toBe(502);
      expect((await response.json()).error.type).toBe("server_error");
    }
    expect(seen).toHaveLength(6);
  } finally {
    await server.stop(true);
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.has(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.has(listener)) process.removeListener("SIGTERM", listener);
    }
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
});
