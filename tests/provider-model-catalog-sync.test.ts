import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileIfUnchanged, defaultConfig } from "../src/config";
import {
  applyCockpitProviderModelCatalogSync,
  prepareCockpitProviderModelCatalogSync,
  startCockpitProviderModelCatalogSync,
  syncCockpitProviderModelCatalog,
} from "../src/provider-model-catalog-sync";

const originalCodexHome = process.env.CODEX_HOME;
const roots: string[] = [];

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  provider = "codex_local_access",
  catalogName = "cockpit-local-access-model-catalog.json",
) {
  const root = mkdtempSync(join(tmpdir(), "provider-catalog-sync-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  const configPath = join(codexHome, "config.toml");
  const catalogPath = join(codexHome, catalogName);
  writeFileSync(configPath, [
    `model_provider = "${provider}"`,
    `model_catalog_json = ${JSON.stringify(catalogName)}`,
    "",
    `[model_providers.${provider}]`,
    'base_url = "http://localhost:57204/v1"',
    "",
  ].join("\n"));
  writeFileSync(catalogPath, `${JSON.stringify({ models: [{
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    priority: 1,
    visibility: "list",
    supported_in_api: true,
    multi_agent_version: "v2",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    tool_mode: "code_mode_only",
  }, { slug: "gpt-5.4", custom: "preserved" }] }, null, 2)}\n`);
  return { codexHome, configPath, catalogPath };
}

describe("Cockpit Provider model catalog sync", () => {
  test("conditional atomic write preserves a newer external update", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-catalog-cas-"));
    roots.push(root);
    const path = join(root, "catalog.json");
    writeFileSync(path, "newer Cockpit content\n");

    expect(atomicWriteFileIfUnchanged(path, "Provider content\n", "stale content\n")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("newer Cockpit content\n");
  });

  test("preserves native models, replaces Web rows, and never changes the Cockpit route", () => {
    const paths = fixture();
    const source = JSON.parse(readFileSync(paths.catalogPath, "utf8")) as { models: unknown[] };
    source.models.push({ slug: "chatgpt-web/stale" });
    writeFileSync(paths.catalogPath, `${JSON.stringify(source, null, 2)}\n`);
    const configBefore = readFileSync(paths.configPath, "utf8");
    const cachePath = join(paths.codexHome, "models_cache.json");
    writeFileSync(cachePath, "stale");
    const config = defaultConfig("full");
    config.proAvailable = true;

    expect(syncCockpitProviderModelCatalog(config)).toEqual({
      changed: true,
      catalogPath: paths.catalogPath,
    });
    const models = (JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
      models: Array<{ slug: string; custom?: string }>;
    }).models;
    expect(models.find(model => model.slug === "gpt-5.4"))
      .toEqual({ slug: "gpt-5.4", custom: "preserved" });
    expect(models.filter(model => model.slug.startsWith("chatgpt-web/"))
      .map(model => model.slug)).toEqual([
        "chatgpt-web/light",
        "chatgpt-web/medium",
        "chatgpt-web/high",
        "chatgpt-web/extra-high",
        "chatgpt-web/pro",
      ]);
    expect(readFileSync(paths.configPath, "utf8")).toBe(configBefore);
    expect(existsSync(cachePath)).toBe(false);
  });

  test("supports Cockpit's v3 model catalog filename", () => {
    const paths = fixture("codex_local_access", "cockpit-model-catalog.json");

    expect(syncCockpitProviderModelCatalog(defaultConfig("full"))).toEqual({
      changed: true,
      catalogPath: paths.catalogPath,
    });
    const models = (JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
      models: Array<{ slug: string }>;
    }).models;
    expect(models.filter(model => model.slug.startsWith("chatgpt-web/")))
      .toHaveLength(5);
  });

  test("does not touch a catalog owned by another Provider", () => {
    const paths = fixture("another_provider");
    const before = readFileSync(paths.catalogPath, "utf8");
    expect(syncCockpitProviderModelCatalog(defaultConfig("full"))).toEqual({ changed: false });
    expect(readFileSync(paths.catalogPath, "utf8")).toBe(before);
  });

  test("does not touch an external catalog that only shares Cockpit's filename", () => {
    const paths = fixture();
    const externalRoot = mkdtempSync(join(tmpdir(), "external-provider-catalog-"));
    roots.push(externalRoot);
    const externalCatalog = join(externalRoot, "cockpit-local-access-model-catalog.json");
    const externalText = readFileSync(paths.catalogPath, "utf8");
    writeFileSync(externalCatalog, externalText);
    writeFileSync(paths.configPath, [
      'model_provider = "codex_local_access"',
      `model_catalog_json = ${JSON.stringify(externalCatalog)}`,
      "",
    ].join("\n"));

    expect(syncCockpitProviderModelCatalog(defaultConfig("full"))).toEqual({ changed: false });
    expect(readFileSync(externalCatalog, "utf8")).toBe(externalText);
  });

  test("always publishes the five stable Provider model IDs regardless of cached capabilities", () => {
    const paths = fixture();
    const config = defaultConfig("full");
    config.solAvailable = false;
    config.proAvailable = false;

    syncCockpitProviderModelCatalog(config);

    const models = (JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
      models: Array<{ slug: string }>;
    }).models;
    expect(models.filter(model => model.slug.startsWith("chatgpt-web/"))
      .map(model => model.slug)).toEqual([
        "chatgpt-web/light",
        "chatgpt-web/medium",
        "chatgpt-web/high",
        "chatgpt-web/extra-high",
        "chatgpt-web/pro",
      ]);
  });

  test("fails closed before writing a malformed Cockpit catalog", () => {
    const paths = fixture();
    writeFileSync(paths.catalogPath, '{"models":"invalid"}\n');
    const before = readFileSync(paths.catalogPath, "utf8");
    expect(() => syncCockpitProviderModelCatalog(defaultConfig("full")))
      .toThrow("Native Codex models response is missing a models array");
    expect(readFileSync(paths.catalogPath, "utf8")).toBe(before);
  });

  test("preserves native models added by Cockpit after sync preparation", () => {
    const paths = fixture();
    const plan = prepareCockpitProviderModelCatalogSync(defaultConfig("full"));
    const current = JSON.parse(readFileSync(paths.catalogPath, "utf8")) as { models: unknown[] };
    current.models.push({ slug: "gpt-cockpit-new", custom: "concurrent" });
    writeFileSync(paths.catalogPath, `${JSON.stringify(current, null, 2)}\n`);

    expect(applyCockpitProviderModelCatalogSync(plan)).toEqual({
      changed: true,
      catalogPath: paths.catalogPath,
    });
    const models = (JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
      models: Array<{ slug: string; custom?: string }>;
    }).models;
    expect(models.find(model => model.slug === "gpt-cockpit-new"))
      .toEqual({ slug: "gpt-cockpit-new", custom: "concurrent" });
    expect(models.filter(model => model.slug.startsWith("chatgpt-web/"))).toHaveLength(5);
  });

  test("restores Provider rows removed by Cockpit after an unchanged preparation", () => {
    const paths = fixture();
    syncCockpitProviderModelCatalog(defaultConfig("full"));
    const plan = prepareCockpitProviderModelCatalogSync(defaultConfig("full"));
    expect(plan.changed).toBe(false);

    const current = JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
      models: Array<{ slug: string }>;
    };
    current.models = current.models.filter(model => !model.slug.startsWith("chatgpt-web/"));
    writeFileSync(paths.catalogPath, `${JSON.stringify(current, null, 2)}\n`);

    expect(applyCockpitProviderModelCatalogSync(plan).changed).toBe(true);
    const models = (JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
      models: Array<{ slug: string }>;
    }).models;
    expect(models.filter(model => model.slug.startsWith("chatgpt-web/"))).toHaveLength(5);
  });

  test("keeps Provider rows present when Cockpit regenerates its owned catalog", async () => {
    const paths = fixture();
    const stop = startCockpitProviderModelCatalogSync(defaultConfig("full"), {
      intervalMs: 10,
      onError(error) { throw error; },
    });
    try {
      const regenerated = JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
        models: Array<{ slug: string }>;
      };
      regenerated.models = regenerated.models.filter(model => !model.slug.startsWith("chatgpt-web/"));
      writeFileSync(paths.catalogPath, `${JSON.stringify(regenerated, null, 2)}\n`);
      await new Promise(resolve => setTimeout(resolve, 35));

      const models = (JSON.parse(readFileSync(paths.catalogPath, "utf8")) as {
        models: Array<{ slug: string }>;
      }).models;
      expect(models.filter(model => model.slug.startsWith("chatgpt-web/"))).toHaveLength(5);
    } finally {
      stop();
    }
  });
});
