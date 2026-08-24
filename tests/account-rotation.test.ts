import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAccountSlot,
  addWorkspaceToAccount,
  availableSlots,
  claimAccountSlot,
  launcherPartitionForSlot,
  loadRotationState,
  markSlotCooldown,
  NO_ACCOUNT_SLOTS_MESSAGE,
  parseAccountRotation,
  pickNextSlot,
  PRIMARY_ACCOUNT_SLOT_ID,
  PRIMARY_CREDENTIAL_ID,
  removeAccountRecord,
  removeAccountSlot,
  renameAccountRecord,
  renameWorkspaceSlot,
  rotationFromConfig,
  saveRotationState,
  setSlotCredentials,
  uniqueCredentials,
  runtimeAliasForCredential,
  updateAccountIdentity,
  type AccountRotationConfig,
} from "../src/account-rotation";

const primaryTunnel = {
  tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  runtimeKeyFile: "/tmp/primary.key",
  alias: "codex-chatgpt-web",
  profileName: "codex-chatgpt-web",
};

const host = {
  storageStatePath: "/tmp/primary-storage.json",
  tunnel: primaryTunnel,
};

function rotation(): AccountRotationConfig {
  return {
    accounts: [{
      id: "account_primary",
      name: "Primary",
      credentialId: PRIMARY_CREDENTIAL_ID,
    }, {
      id: "account_other",
      name: "Second account",
      credentialId: "cred_other",
    }],
    credentials: [{
      id: PRIMARY_CREDENTIAL_ID,
      ...primaryTunnel,
    }, {
      id: "cred_other",
      tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeKeyFile: "/tmp/other.key",
      alias: "codex-chatgpt-web-cred_other",
      profileName: "codex-chatgpt-web",
    }],
    slots: [
      {
        id: PRIMARY_ACCOUNT_SLOT_ID,
        accountId: "account_primary",
        label: "Primary",
        storageStatePath: "/tmp/primary-storage.json",
        credentialId: PRIMARY_CREDENTIAL_ID,
      },
      {
        id: "slot_ws2",
        accountId: "account_primary",
        label: "Same account workspace 2",
        storageStatePath: "/tmp/ws2-storage.json",
        credentialId: PRIMARY_CREDENTIAL_ID,
      },
      {
        id: "slot_acct2",
        accountId: "account_other",
        label: "Second account",
        storageStatePath: "/tmp/acct2-storage.json",
        credentialId: "cred_other",
      },
    ],
  };
}

function withRotationHome<T>(run: () => T): T {
  const home = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-rotation-test-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("same-account workspaces share one tunnel credential while a second account keeps its own", () => {
  const config = rotation();
  expect(uniqueCredentials(config)).toHaveLength(2);
  expect(config.slots.filter(slot => slot.credentialId === PRIMARY_CREDENTIAL_ID)).toHaveLength(2);
  expect(config.slots.filter(slot => slot.credentialId === "cred_other")).toHaveLength(1);
});

test("rotates a live slot on every pick and skips cooling accounts", () => {
  const config = rotation();
  const first = pickNextSlot(config, { nextIndex: 0, cooldowns: {} });
  expect(first.selected.slot.id).toBe(PRIMARY_ACCOUNT_SLOT_ID);
  const second = pickNextSlot(config, first.state);
  expect(second.selected.slot.id).toBe("slot_ws2");
  const cooled = markSlotCooldown(second.state, "slot_ws2", 1_000, 60_000);
  const third = pickNextSlot(config, cooled, 1_000);
  expect(third.selected.slot.id).not.toBe("slot_ws2");
});

test("cooling a slot preserves the round-robin cursor in the full slot order", () => {
  const config = rotation();
  const picked = pickNextSlot(config, {
    nextIndex: 1,
    cooldowns: { [PRIMARY_ACCOUNT_SLOT_ID]: 60_000 },
  }, 1_000);

  expect(picked.selected.slot.id).toBe("slot_ws2");
  expect(picked.state.nextIndex).toBe(2);
});

test("fails closed when every account is cooling down", () => {
  const config = rotation();
  const cooled = {
    nextIndex: 0,
    cooldowns: {
      [PRIMARY_ACCOUNT_SLOT_ID]: 50_000,
      slot_ws2: 50_000,
      slot_acct2: 50_000,
    },
  };
  expect(availableSlots(config, cooled, 1_000)).toEqual([]);
  expect(() => pickNextSlot(config, cooled, 1_000)).toThrow("cooling down");
});

test("configured rotation claims only workspaces explicitly marked signed in", () => {
  const configured = rotation();
  configured.slots[2]!.signedIn = true;

  const selected = withRotationHome(() => claimAccountSlot({ ...host, accountRotation: configured }));

  expect(selected.slot.id).toBe("slot_acct2");
});

test("signing out one workspace preserves the cursor in the full round-robin order", () => {
  withRotationHome(() => {
    const configured = rotation();
    configured.slots = configured.slots.map(slot => ({ ...slot, signedIn: true }));
    expect(claimAccountSlot({ ...host, accountRotation: configured }).slot.id).toBe(PRIMARY_ACCOUNT_SLOT_ID);

    configured.slots[0]!.signedIn = false;
    expect(claimAccountSlot({ ...host, accountRotation: configured }).slot.id).toBe("slot_ws2");
  });
});

test("configured rotation fails closed when no workspace is marked signed in", () => {
  expect(() => withRotationHome(() => claimAccountSlot({ ...host, accountRotation: rotation() })))
    .toThrow(NO_ACCOUNT_SLOTS_MESSAGE);
});

test("legacy configuration without accountRotation still claims the primary workspace", () => {
  const selected = withRotationHome(() => claimAccountSlot(host));
  expect(selected.slot.id).toBe(PRIMARY_ACCOUNT_SLOT_ID);
});

test("a failed atomic rotation-state replacement preserves the last complete state", () => {
  if (process.platform === "win32") return;
  const home = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-rotation-atomic-"));
  try {
    saveRotationState({ nextIndex: 1, cooldowns: { primary: 123 } }, home);
    chmodSync(join(home, "runtime"), 0o500);
    expect(() => saveRotationState({ nextIndex: 2, cooldowns: {} }, home)).toThrow();
    chmodSync(join(home, "runtime"), 0o700);
    expect(loadRotationState(home)).toEqual({ nextIndex: 1, cooldowns: { primary: 123 } });
  } finally {
    chmodSync(join(home, "runtime"), 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent cooldown writers preserve every slot", async () => {
  if (process.env.CODEX_SKIP_PROCESS_CONCURRENCY_TESTS === "1") return;
  const home = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-rotation-concurrent-"));
  try {
    saveRotationState({ nextIndex: 0, cooldowns: {} }, home);
    const moduleUrl = new URL("../src/account-rotation.ts", import.meta.url).href;
    // Bun 1.4.0 on Windows can crash its test runner after high fan-out child-process tests.
    // Four writers still exercise real cross-process overlap there; Unix keeps the stress fan-out.
    const writerCount = process.platform === "win32" ? 4 : 12;
    const slotIds = Array.from({ length: writerCount }, (_, index) => `slot_${index}`);
    const children = slotIds.map(slotId => Bun.spawn([
      process.execPath,
      "-e",
      `const { coolAccountSlot } = await import(${JSON.stringify(moduleUrl)}); coolAccountSlot(${JSON.stringify(slotId)}, 1000);`,
    ], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home },
      stdout: "ignore",
      stderr: "pipe",
    }));
    const results = await Promise.all(children.map(async child => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })));
    expect(results).toEqual(slotIds.map(() => ({ exitCode: 0, stderr: "" })));
    expect(Object.keys(loadRotationState(home).cooldowns).sort()).toEqual(slotIds.sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("primary partition stays on the existing launcher session", () => {
  expect(launcherPartitionForSlot(PRIMARY_ACCOUNT_SLOT_ID)).toBe("persist:codex-web-gpt-chatgpt");
  expect(launcherPartitionForSlot("slot_ws2")).toBe("persist:codex-web-gpt-chatgpt-slot_ws2");
});

test("adding a workspace reuses primary tunnel credentials", () => {
  const added = addAccountSlot(host, { label: "Workspace B", reuseCredentialId: PRIMARY_CREDENTIAL_ID });
  expect(added.slot.credentialId).toBe(PRIMARY_CREDENTIAL_ID);
  expect(added.config.accountRotation!.slots.some((slot: { id: string }) => slot.id === PRIMARY_ACCOUNT_SLOT_ID)).toBeTrue();
  expect(added.config.accountRotation!.slots).toHaveLength(2);
});

test("first rotation migration keeps the legacy primary workspace eligible", () => {
  const added = addAccountSlot(host, { label: "Second account", reuseCredentialId: PRIMARY_CREDENTIAL_ID });
  expect(added.config.accountRotation!.slots.find(slot => slot.id === PRIMARY_ACCOUNT_SLOT_ID)?.signedIn).toBeTrue();
});

test("same tunnel id with a different API key keeps a second credential", () => {
  const added = addAccountSlot(host, {
    label: "Org member",
    tunnelId: primaryTunnel.tunnelId,
    runtimeKeyFile: "/tmp/member.key",
  });
  expect(added.slot.credentialId).not.toBe(PRIMARY_CREDENTIAL_ID);
  expect(uniqueCredentials(added.config.accountRotation!)).toHaveLength(2);
  expect(added.config.accountRotation!.credentials.map(credential => credential.tunnelId)).toEqual([
    primaryTunnel.tunnelId,
    primaryTunnel.tunnelId,
  ]);
  expect(added.config.accountRotation!.credentials.map(credential => credential.alias)).toEqual([
    primaryTunnel.alias,
    primaryTunnel.alias,
  ]);
  expect(runtimeAliasForCredential(added.config, added.config.accountRotation!.credentials[1]!)).toBe(primaryTunnel.alias);
});

test("the same tunnel id and API key reuses the primary credential", () => {
  const added = addAccountSlot(host, {
    label: "icloud",
    tunnelId: primaryTunnel.tunnelId,
    runtimeKeyFile: primaryTunnel.runtimeKeyFile,
  });
  expect(added.slot.credentialId).toBe(PRIMARY_CREDENTIAL_ID);
});

test("set-credentials can attach a shared tunnel and a different API key to existing slots", () => {
  const updated = setSlotCredentials({ ...host, accountRotation: rotation() }, ["slot_acct2"], {
    tunnelId: primaryTunnel.tunnelId,
    runtimeKeyFile: "/tmp/0ruka.key",
  });
  const slot = updated.accountRotation!.slots.find(candidate => candidate.id === "slot_acct2");
  expect(slot?.credentialId).not.toBe(PRIMARY_CREDENTIAL_ID);
  expect(updated.accountRotation!.credentials.some(credential => (
    credential.id === slot?.credentialId && credential.tunnelId === primaryTunnel.tunnelId
  ))).toBeTrue();
});

test("set-credentials keeps an account and all of its workspaces on one credential", () => {
  const updated = setSlotCredentials({ ...host, accountRotation: rotation() }, [PRIMARY_ACCOUNT_SLOT_ID], {
    reuseCredentialId: "cred_other",
  });
  const account = updated.accountRotation!.accounts.find(candidate => candidate.id === "account_primary");
  const accountSlots = updated.accountRotation!.slots.filter(slot => slot.accountId === "account_primary");

  expect(account?.credentialId).toBe("cred_other");
  expect(accountSlots.map(slot => slot.credentialId)).toEqual(["cred_other", "cred_other"]);
  expect(() => addWorkspaceToAccount(updated, { accountId: "account_primary" })).not.toThrow();
});

test("a new named account starts with Workspace 1 instead of reusing the account title", () => {
  const added = addAccountSlot(host, {
    label: "0ruka",
    tunnelId: "tunnel_cccccccccccccccccccccccccccccccc",
    runtimeKeyFile: "/tmp/0ruka.key",
    asNewAccount: true,
  });
  const account = added.config.accountRotation!.accounts.find(candidate => candidate.name === "0ruka");
  expect(account).toBeTruthy();
  expect(added.slot.accountId).toBe(account!.id);
  expect(added.slot.label).toBe("Workspace 1");
});

test("another workspace stays on the chosen account even when credentials match", () => {
  const first = addAccountSlot(host, {
    label: "0ruka",
    tunnelId: "tunnel_cccccccccccccccccccccccccccccccc",
    runtimeKeyFile: "/tmp/0ruka.key",
    asNewAccount: true,
  });
  const accountId = first.slot.accountId;
  const second = addWorkspaceToAccount(first.config, { accountId, name: "0ruka US" });
  expect(second.slot.accountId).toBe(accountId);
  expect(second.slot.label).toBe("0ruka US");
  expect(second.slot.credentialId).toBe(first.slot.credentialId);
});

test("login identity stores email on the account and the ChatGPT workspace name on that slot", () => {
  const updated = updateAccountIdentity({ ...host, accountRotation: rotation() }, "slot_ws2", {
    email: "jamie950315@icloud.com",
    workspaceName: "US",
    signedIn: true,
  });
  const account = updated.accountRotation!.accounts.find(candidate => candidate.id === "account_primary");
  const slot = updated.accountRotation!.slots.find(candidate => candidate.id === "slot_ws2");
  expect(account?.email).toBe("jamie950315@icloud.com");
  expect(slot?.chatgptWorkspaceName).toBe("US");
  expect(slot?.signedIn).toBe(true);
});

test("an expired workspace is persisted signed out and skipped by future claims", () => {
  const configured = rotation();
  for (const slot of configured.slots) slot.signedIn = true;
  const updated = updateAccountIdentity({ ...host, accountRotation: configured }, PRIMARY_ACCOUNT_SLOT_ID, {
    signedIn: false,
  });
  const reparsed = parseAccountRotation(updated.accountRotation, "/tmp/config.json");

  expect(reparsed.slots.find(slot => slot.id === PRIMARY_ACCOUNT_SLOT_ID)?.signedIn).toBe(false);
  const selected = withRotationHome(() => claimAccountSlot({ ...host, accountRotation: reparsed }));
  expect(selected.slot.id).toBe("slot_ws2");
});

test("renaming an unknown account fails instead of reporting success", () => {
  expect(() => renameAccountRecord({ ...host, accountRotation: rotation() }, "account_missing", "New name"))
    .toThrow("Unknown account");
});

test("renaming an unknown workspace fails instead of reporting success", () => {
  expect(() => renameWorkspaceSlot({ ...host, accountRotation: rotation() }, "slot_missing", "New name"))
    .toThrow("Unknown account slot");
});

test("does not persist ChatGPT chrome labels as a workspace name", () => {
  const updated = updateAccountIdentity({ ...host, accountRotation: rotation() }, "slot_ws2", {
    workspaceName: "開啟側邊欄",
    signedIn: true,
  });
  const slot = updated.accountRotation!.slots.find(candidate => candidate.id === "slot_ws2");
  expect(slot?.chatgptWorkspaceName).toBeUndefined();
  expect(slot?.signedIn).toBe(true);
});

test("adding a distinct account creates a second tunnel credential", () => {
  const added = addAccountSlot(host, {
    label: "Account B",
    tunnelId: "tunnel_cccccccccccccccccccccccccccccccc",
    runtimeKeyFile: "/tmp/b.key",
  });
  expect(added.slot.credentialId).not.toBe(PRIMARY_CREDENTIAL_ID);
  expect(uniqueCredentials(added.config.accountRotation!)).toHaveLength(2);
});

test("the primary workspace can be removed when another workspace remains", () => {
  const updated = removeAccountSlot({ ...host, accountRotation: rotation() }, PRIMARY_ACCOUNT_SLOT_ID);
  expect(updated.accountRotation!.slots.map(slot => slot.id)).toEqual(["slot_ws2", "slot_acct2"]);
  expect(updated.accountRotation!.accounts.some(account => account.id === "account_primary")).toBeTrue();
});

test("removing an account deletes every workspace on that login", () => {
  const updated = removeAccountRecord({ ...host, accountRotation: rotation() }, "account_other");
  expect(updated.accountRotation!.accounts.map(account => account.id)).toEqual(["account_primary"]);
  expect(updated.accountRotation!.slots.map(slot => slot.id)).toEqual([PRIMARY_ACCOUNT_SLOT_ID, "slot_ws2"]);
  expect(updated.accountRotation!.credentials.some(credential => credential.id === "cred_other")).toBeFalse();
});

test("the primary account can be removed when another account remains", () => {
  const updated = removeAccountRecord({ ...host, accountRotation: rotation() }, "account_primary");
  expect(updated.accountRotation!.accounts.map(account => account.id)).toEqual(["account_other"]);
  expect(updated.accountRotation!.slots.map(slot => slot.id)).toEqual(["slot_acct2"]);
});

test("removing the last account leaves no leftover login", () => {
  const onlyPrimary = {
    accounts: [{ id: "account_primary", name: "0ruka US", credentialId: PRIMARY_CREDENTIAL_ID }],
    credentials: [{ id: PRIMARY_CREDENTIAL_ID, ...primaryTunnel }],
    slots: [{
      id: PRIMARY_ACCOUNT_SLOT_ID,
      accountId: "account_primary",
      label: "Primary",
      storageStatePath: "/tmp/primary-storage.json",
      credentialId: PRIMARY_CREDENTIAL_ID,
    }],
  };
  const updated = removeAccountRecord({ ...host, accountRotation: onlyPrimary }, "account_primary");
  expect(updated.accountRotation!.accounts).toEqual([]);
  expect(updated.accountRotation!.slots).toEqual([]);
  expect(() => pickNextSlot(updated.accountRotation!, { nextIndex: 0, cooldowns: {} })).toThrow(NO_ACCOUNT_SLOTS_MESSAGE);
});

test("adding the first account after a wipe does not recreate Primary", () => {
  const emptyHost = {
    ...host,
    accountRotation: { accounts: [], slots: [], credentials: [] },
  };
  const added = addAccountSlot(emptyHost, {
    label: "0ruka",
    tunnelId: "tunnel_cccccccccccccccccccccccccccccccc",
    runtimeKeyFile: "/tmp/0ruka.key",
    asNewAccount: true,
  });
  expect(added.config.accountRotation!.accounts.map(account => account.name)).toEqual(["0ruka"]);
  expect(added.config.accountRotation!.slots.every(slot => slot.id !== PRIMARY_ACCOUNT_SLOT_ID)).toBeTrue();
});

test("default rotation is the current login and tunnel", () => {
  const config = rotationFromConfig(host);
  expect(config.slots).toEqual([expect.objectContaining({ id: PRIMARY_ACCOUNT_SLOT_ID })]);
  expect(config.credentials[0]?.tunnelId).toBe(primaryTunnel.tunnelId);
});

const invalidRotationCases: Array<{
  name: string;
  expected: string;
  mutate: (value: AccountRotationConfig) => void;
}> = [
  {
    name: "duplicate account ids",
    expected: "Duplicate accountRotation account ids",
    mutate: value => { value.accounts.push({ ...value.accounts[0]! }); },
  },
  {
    name: "orphan workspace accounts",
    expected: "references unknown account",
    mutate: value => { value.slots[0]!.accountId = "account_missing"; },
  },
  {
    name: "accounts without workspaces",
    expected: "has no workspaces",
    mutate: value => { value.accounts.push({ id: "account_empty", name: "Empty", credentialId: "primary" }); },
  },
  {
    name: "unknown account credentials",
    expected: "references unknown credential",
    mutate: value => { value.accounts[0]!.credentialId = "cred_missing"; },
  },
  {
    name: "workspace credentials inconsistent with their account",
    expected: "does not match account",
    mutate: value => { value.slots[0]!.credentialId = "cred_other"; },
  },
  {
    name: "relative runtime key paths",
    expected: "runtimeKeyFile must be absolute",
    mutate: value => { value.credentials[0]!.runtimeKeyFile = "relative.key"; },
  },
  {
    name: "relative storage state paths",
    expected: "storageStatePath must be absolute",
    mutate: value => { value.slots[0]!.storageStatePath = "relative.json"; },
  },
  {
    name: "unsafe slot ids",
    expected: "Invalid accountRotation.slots[0].id",
    mutate: value => { value.slots[0]!.id = "../slot"; },
  },
  {
    name: "unsafe derived account ids",
    expected: "Invalid accountRotation account id",
    mutate: value => {
      value.accounts = [];
      value.slots[0]!.accountId = "../account";
    },
  },
  {
    name: "unsafe credential aliases",
    expected: "Invalid accountRotation.credentials[0].alias",
    mutate: value => { value.credentials[0]!.alias = "alias\nnext"; },
  },
];

for (const invalid of invalidRotationCases) {
  test(`rejects ${invalid.name}`, () => {
    const value = structuredClone(rotation());
    invalid.mutate(value);
    expect(() => parseAccountRotation(value, "/tmp/config.json")).toThrow(invalid.expected);
  });
}
