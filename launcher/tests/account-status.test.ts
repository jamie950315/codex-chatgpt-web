import { expect, test } from "bun:test";

globalThis.window = { codexWebLauncher: undefined } as unknown as Window & typeof globalThis;
const app = await import("../src/App");

test("historical account email stays a label and cannot prove a signed-in workspace", () => {
  expect(typeof app.accountHasVerifiedLogin).toBe("function");
  expect(app.accountHasVerifiedLogin({
    id: "account_old",
    name: "Old account",
    email: "historical@example.com",
    credentialId: "credential_old",
    workspaces: [{
      id: "slot_old",
      name: "Workspace",
      signedIn: false,
      partition: "persist:slot_old",
      credentialId: "credential_old",
    }],
  }, false)).toBe(false);
});

test("verified workspace state controls account and workspace login availability", () => {
  expect(app.accountHasVerifiedLogin({
    id: "account_live",
    name: "Live account",
    credentialId: "credential_live",
    workspaces: [{
      id: "slot_live",
      name: "Workspace",
      signedIn: true,
      partition: "persist:slot_live",
      credentialId: "credential_live",
    }],
  }, false)).toBe(true);
  expect(app.workspaceHasVerifiedLogin({ id: "primary", signedIn: false }, true)).toBe(true);
  expect(app.workspaceHasVerifiedLogin({ id: "slot_old", signedIn: false }, true)).toBe(false);
});
