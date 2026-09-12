import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { syncCockpitModelCatalog } from "../src/cockpit-model-catalog-sync";

const originalCodexHome = process.env.CODEX_HOME;
const roots: string[] = [];

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { provider?: string; catalogName?: string; omitProvider?: boolean } = {}) {
  const catalogName = options.catalogName ?? "cockpit-model-catalog.json";
  const root = mkdtempSync(join(tmpdir(), "cockpit-catalog-sync-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  const lines = [
    ...(options.omitProvider ? [] : [`model_provider = "${options.provider ?? "codex_local_access"}"`]),
    `model_catalog_json = ${JSON.stringify(catalogName)}`,
    "",
  ];
  writeFileSync(join(codexHome, "config.toml"), lines.join("\n"));
  const catalogPath = join(codexHome, catalogName);
  writeFileSync(catalogPath, `${JSON.stringify({ models: [{
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    priority: 1,
    visibility: "list",
    supported_in_api: true,
    multi_agent_version: "v2",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    tool_mode: "code_mode_only",
  }, {
    slug: "CPA/grok-4.6",
    display_name: "Grok-4.6",
    custom: "preserved",
  }] }, null, 2)}\n`);
  return { catalogPath };
}

test("injects ChatGPT Web models into the Cockpit catalog without replacing CPA rows", () => {
  const { catalogPath } = fixture({ omitProvider: true });
  const config = defaultConfig("full");
  config.proAvailable = true;

  expect(syncCockpitModelCatalog(config)).toEqual({ changed: true, catalogPath });
  const models = (JSON.parse(readFileSync(catalogPath, "utf8")) as {
    models: Array<{ slug: string; display_name?: string; custom?: string }>;
  }).models;
  expect(models.find(model => model.slug === "CPA/grok-4.6"))
    .toEqual({ slug: "CPA/grok-4.6", display_name: "Grok-4.6", custom: "preserved" });
  expect(models.filter(model => model.slug.startsWith("chatgpt-web/")).map(model => model.slug)).toEqual([
    "chatgpt-web/light",
    "chatgpt-web/medium",
    "chatgpt-web/high",
    "chatgpt-web/extra-high",
    "chatgpt-web/pro",
  ]);
});

test("does not rewrite a catalog owned by another provider", () => {
  const { catalogPath } = fixture({ provider: "another_provider" });
  const before = readFileSync(catalogPath, "utf8");
  expect(syncCockpitModelCatalog(defaultConfig("full"))).toEqual({ changed: false });
  expect(readFileSync(catalogPath, "utf8")).toBe(before);
});
