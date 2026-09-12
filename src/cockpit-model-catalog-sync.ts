import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import { findTopLevelAssignment, splitLines } from "./codex-integration-document";
import {
  getCodexConfigPath,
  getCodexHome,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
import { augmentNativeModelCatalog } from "./model-catalog";

export interface CockpitModelCatalogSyncResult {
  changed: boolean;
  catalogPath?: string;
}

const COCKPIT_MODEL_CATALOG_FILENAMES = new Set([
  "cockpit-local-access-model-catalog.json",
  "cockpit-model-catalog.json",
]);

function catalogConfig(config: AppConfig): AppConfig {
  return { ...config, subagentProtocol: "native" };
}

function cockpitOwnedCatalogPath(catalogValue: string): string | undefined {
  const catalogPath = isAbsolute(catalogValue)
    ? catalogValue
    : join(getCodexHome(), catalogValue);
  const owned = [...COCKPIT_MODEL_CATALOG_FILENAMES]
    .map(filename => resolve(join(getCodexHome(), filename)));
  if (!owned.includes(resolve(catalogPath)) || !existsSync(catalogPath)) return undefined;
  return catalogPath;
}

/**
 * Keep Cockpit's picker in sync with ChatGPT Web models while Codex traffic still enters
 * the local bridge. Native CPA/OAuth rows are left untouched.
 */
export function syncCockpitModelCatalog(config: AppConfig): CockpitModelCatalogSyncResult {
  const configPath = getCodexConfigPath();
  if (!existsSync(configPath)) return { changed: false };
  const lines = splitLines(readFileSync(configPath, "utf8"));
  const provider = findTopLevelAssignment(lines, "model_provider");
  const catalog = findTopLevelAssignment(lines, "model_catalog_json");
  if (provider.present && provider.value !== "codex_local_access") return { changed: false };
  if (!catalog.value) return { changed: false };
  const catalogPath = cockpitOwnedCatalogPath(catalog.value);
  if (!catalogPath) return { changed: false };

  const sourceText = readFileSync(catalogPath, "utf8");
  const augmented = augmentNativeModelCatalog(JSON.parse(sourceText) as unknown, catalogConfig(config));
  const nextText = `${JSON.stringify(augmented, null, 2)}\n`;
  if (nextText === sourceText) return { changed: false, catalogPath };
  atomicWriteFile(catalogPath, nextText);
  rmSync(getCodexModelsCachePath(), { force: true });
  return { changed: true, catalogPath };
}

export function startCockpitModelCatalogSync(
  config: AppConfig,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  const reconcile = () => {
    try {
      syncCockpitModelCatalog(config);
    } catch (error) {
      options.onError?.(error);
    }
  };
  reconcile();
  const timer = setInterval(reconcile, options.intervalMs ?? 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
