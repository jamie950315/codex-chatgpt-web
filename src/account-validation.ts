import { existsSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import {
  PRIMARY_CREDENTIAL_ID,
  credentialForSlot,
  rotationFromConfig,
  runtimeAliasForCredential,
  type AccountCredential,
} from "./account-rotation";
import { tunnelStatusForAlias } from "./tunnel";

export type ValidationStatus = "ok" | "error" | "warning" | "skipped";

export interface ValidationCheck {
  status: ValidationStatus;
  message: string;
  detail?: string;
}

export interface WorkspaceValidation {
  id: string;
  name: string;
  chatgptWorkspaceName?: string;
  login: ValidationCheck;
  connector?: ValidationCheck;
}

export interface AccountValidation {
  id: string;
  name: string;
  email?: string;
  tunnel: ValidationCheck;
  workspaces: WorkspaceValidation[];
}

export interface AccountValidationReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  accounts: AccountValidation[];
}

function privateFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

export function validateAccountCredential(
  config: AppConfig,
  credential: AccountCredential | undefined,
): ValidationCheck {
  if (config.mode !== "full") {
    return { status: "skipped", message: "Browser-only mode has no MCP tunnel" };
  }
  if (!credential) {
    return { status: "error", message: "This account has no tunnel ID or API key" };
  }
  if (!/^tunnel_[a-f0-9]{32}$/.test(credential.tunnelId)) {
    return { status: "error", message: "Tunnel ID is invalid", detail: credential.tunnelId };
  }
  if (!existsSync(credential.runtimeKeyFile)) {
    return { status: "error", message: "Tunnel API key file is missing", detail: credential.runtimeKeyFile };
  }
  if (!privateFile(credential.runtimeKeyFile)) {
    return { status: "error", message: "Tunnel API key file has unsafe permissions" };
  }
  const status = tunnelStatusForAlias(config, runtimeAliasForCredential(config, credential));
  if (!status.ok) {
    return {
      status: "error",
      message: "Tunnel is not running for this account",
      detail: compactTunnelDetail(status.detail),
    };
  }
  return { status: "ok", message: "Tunnel is ready" };
}

function compactTunnelDetail(detail: string): string {
  const withoutLog = detail.replace(/;?\s*runtime_log=.*$/s, "").trim();
  if (!withoutLog) return "the tunnel runtime is stopped";
  return withoutLog.length > 280 ? `${withoutLog.slice(0, 277)}…` : withoutLog;
}

export function validateStoredWorkspaceLogin(signedIn: boolean): ValidationCheck {
  if (!signedIn) {
    return { status: "error", message: "Not signed in to ChatGPT on this workspace" };
  }
  return { status: "ok", message: "ChatGPT session is marked signed in" };
}

export function validateAccountsStatic(config: AppConfig): AccountValidationReport {
  const rotation = rotationFromConfig(config);
  const primaryCredential: AccountCredential | undefined = config.tunnel
    ? {
      id: PRIMARY_CREDENTIAL_ID,
      tunnelId: config.tunnel.tunnelId,
      runtimeKeyFile: config.tunnel.runtimeKeyFile,
      alias: config.tunnel.alias,
      profileName: config.tunnel.profileName,
    }
    : undefined;
  const accounts = rotation.accounts.map(account => {
    const slot = rotation.slots.find(candidate => candidate.accountId === account.id);
    const credential = (slot ? credentialForSlot(rotation, slot) : undefined)
      || rotation.credentials.find(candidate => candidate.id === account.credentialId)
      || (account.credentialId === PRIMARY_CREDENTIAL_ID ? primaryCredential : undefined);
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      tunnel: validateAccountCredential(config, credential),
      workspaces: rotation.slots.filter(candidate => candidate.accountId === account.id).map(workspace => ({
        id: workspace.id,
        name: workspace.label,
        chatgptWorkspaceName: workspace.chatgptWorkspaceName,
        login: validateStoredWorkspaceLogin(workspace.signedIn === true),
      })),
    };
  });
  return {
    ok: accounts.every(account => (
      account.tunnel.status !== "error"
      && account.workspaces.every(workspace => workspace.login.status !== "error")
    )),
    mode: config.mode,
    accounts,
  };
}
