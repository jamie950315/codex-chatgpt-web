import { expect, test } from "bun:test";
import { validateAccountCredential, validateAccountsStatic, validateStoredWorkspaceLogin } from "../src/account-validation";
import { PRIMARY_ACCOUNT_SLOT_ID, PRIMARY_CREDENTIAL_ID, type AccountRotationConfig } from "../src/account-rotation";

const rotation: AccountRotationConfig = {
  accounts: [{
    id: "account_primary",
    name: "icloud",
    credentialId: PRIMARY_CREDENTIAL_ID,
  }],
  credentials: [],
  slots: [{
    id: PRIMARY_ACCOUNT_SLOT_ID,
    accountId: "account_primary",
    label: "Workspace 1",
    storageStatePath: "/tmp/primary-storage.json",
    credentialId: PRIMARY_CREDENTIAL_ID,
  }],
};

test("browser-only accounts skip tunnel checks", () => {
  const report = validateAccountsStatic({
    mode: "browser-only",
    storageStatePath: "/tmp/storage.json",
    accountRotation: rotation,
  } as never);
  expect(report.accounts[0]?.tunnel.status).toBe("skipped");
});

test("missing tunnel credentials fail the account check", () => {
  const report = validateAccountsStatic({
    mode: "full",
    storageStatePath: "/tmp/storage.json",
    accountRotation: {
      ...rotation,
      accounts: [{ id: "account_x", name: "0ruka", credentialId: "missing" }],
      slots: [{
        id: "slot_x",
        accountId: "account_x",
        label: "UK",
        storageStatePath: "/tmp/x.json",
        credentialId: "missing",
      }],
    },
  } as never);
  expect(report.ok).toBe(false);
  expect(report.accounts[0]?.name).toBe("0ruka");
  expect(report.accounts[0]?.tunnel.status).toBe("error");
  expect(report.accounts[0]?.tunnel.message).toContain("tunnel ID or API key");
});

test("unsigned workspaces are reported by account and workspace name", () => {
  const report = validateAccountsStatic({
    mode: "browser-only",
    storageStatePath: "/tmp/storage.json",
    accountRotation: {
      ...rotation,
      slots: [{
        ...rotation.slots[0]!,
        signedIn: false,
      }],
    },
  } as never);
  expect(report.ok).toBe(false);
  expect(report.accounts[0]?.workspaces[0]?.name).toBe("Workspace 1");
  expect(report.accounts[0]?.workspaces[0]?.login.status).toBe("error");
});

test("a signed-in workspace passes the stored login check", () => {
  expect(validateStoredWorkspaceLogin(true).status).toBe("ok");
  expect(validateStoredWorkspaceLogin(false).status).toBe("error");
});

test("browser-only credentials are skipped even when a key is present", () => {
  expect(validateAccountCredential({ mode: "browser-only" } as never, {
    id: "cred",
    tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runtimeKeyFile: "/tmp/missing.key",
    alias: "alias",
    profileName: "profile",
  }).status).toBe("skipped");
});
