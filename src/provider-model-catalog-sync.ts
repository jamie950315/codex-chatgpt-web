import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFileIfUnchanged } from "./config";
import { findTopLevelAssignment, splitLines } from "./codex-integration-document";
import {
  getCodexConfigPath,
  getCodexHome,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
import { augmentNativeModelCatalog } from "./model-catalog";

export interface ProviderModelCatalogSyncResult {
  changed: boolean;
  catalogPath?: string;
}

interface ProviderModelCatalogSyncPlan extends ProviderModelCatalogSyncResult {
  config?: AppConfig;
  nextText?: string;
  sourceText?: string;
}

const COCKPIT_MODEL_CATALOG_FILENAMES = new Set([
  "cockpit-local-access-model-catalog.json",
  "cockpit-model-catalog.json",
]);

function providerCatalogConfig(config: AppConfig): AppConfig {
  return { ...config, solAvailable: true, proAvailable: true, subagentProtocol: "native" };
}

/**
 * Keep Cockpit's Codex picker in sync with the independent Provider without taking over its route.
 * The strict provider and filename checks prevent Provider setup from rewriting an unrelated custom
 * model catalog owned by the user or another application.
 */
export function prepareCockpitProviderModelCatalogSync(
  config: AppConfig,
): ProviderModelCatalogSyncPlan {
  const configPath = getCodexConfigPath();
  if (!existsSync(configPath)) return { changed: false };
  const configText = readFileSync(configPath, "utf8");
  const lines = splitLines(configText);
  const provider = findTopLevelAssignment(lines, "model_provider");
  const catalog = findTopLevelAssignment(lines, "model_catalog_json");
  if (provider.value !== "codex_local_access" || !catalog.value) return { changed: false };

  const catalogPath = isAbsolute(catalog.value)
    ? catalog.value
    : join(getCodexHome(), catalog.value);
  const ownedCatalogPaths = [...COCKPIT_MODEL_CATALOG_FILENAMES]
    .map(filename => resolve(join(getCodexHome(), filename)));
  if (!ownedCatalogPaths.includes(resolve(catalogPath)) || !existsSync(catalogPath)) {
    return { changed: false };
  }

  const sourceText = readFileSync(catalogPath, "utf8");
  const source = JSON.parse(sourceText) as unknown;
  // Cockpit owns the native rows and Codex feature policy. The bridge's Compatibility V1 mode is
  // only for a directly managed route, so preserve Cockpit's native protocol metadata verbatim.
  const augmented = augmentNativeModelCatalog(source, providerCatalogConfig(config));
  const nextText = `${JSON.stringify(augmented, null, 2)}\n`;
  const changed = nextText !== sourceText;
  return {
    changed,
    catalogPath,
    config: providerCatalogConfig(config),
    sourceText,
    ...(changed ? { nextText } : {}),
  };
}

export function applyCockpitProviderModelCatalogSync(
  plan: ProviderModelCatalogSyncPlan,
): ProviderModelCatalogSyncResult {
  if (!plan.catalogPath || !plan.config || plan.sourceText === undefined) return { changed: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = prepareCockpitProviderModelCatalogSync(plan.config);
    if (!latest.catalogPath || resolve(latest.catalogPath) !== resolve(plan.catalogPath)) {
      return { changed: false };
    }
    const currentText = readFileSync(plan.catalogPath, "utf8");
    if (currentText !== latest.sourceText) continue;
    if (!latest.changed || latest.nextText === undefined) {
      return { changed: false, catalogPath: plan.catalogPath };
    }
    if (!atomicWriteFileIfUnchanged(plan.catalogPath, latest.nextText, currentText)) continue;
    rmSync(getCodexModelsCachePath(), { force: true });
    return { changed: true, catalogPath: plan.catalogPath };
  }
  throw new Error("Cockpit model catalog changed repeatedly during Provider synchronization");
}

export function syncCockpitProviderModelCatalog(
  config: AppConfig,
): ProviderModelCatalogSyncResult {
  return applyCockpitProviderModelCatalogSync(prepareCockpitProviderModelCatalogSync(config));
}

export function startCockpitProviderModelCatalogSync(
  config: AppConfig,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  const reconcile = () => {
    try {
      syncCockpitProviderModelCatalog(config);
    } catch (error) {
      options.onError?.(error);
    }
  };
  reconcile();
  const timer = setInterval(reconcile, options.intervalMs ?? 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
