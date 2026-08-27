import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { loadRotationState, saveRotationState } from "../src/account-rotation";

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  options: { preload?: string } = {},
) {
  const child = Bun.spawn([
    process.execPath,
    ...(options.preload ? ["--preload", options.preload] : []),
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function browserOnlyConfig(appHome: string, accountRotation?: Record<string, unknown>) {
  return {
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native2",
    browserHost: "managed-chrome",
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    solAvailable: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "account-lifecycle-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...(accountRotation ? { accountRotation } : {}),
  };
}

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--chrome",
      process.execPath,
      "--browser-host-descriptor",
      join(root, "launcher-browser.json"),
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    const { stderr } = result;
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Choose either --chrome or --browser-host-descriptor");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV chat list works without starting launcher, broker, or Responses services", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-list-"));
  try {
    const result = await runCli(["dev", "list"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_HOME: join(root, "codex"),
    });
    expect(result).toEqual({ exitCode: 0, stdout: "No named DEV chats yet.\n", stderr: "" });
    expect(existsSync(join(root, "codex", "config.toml"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV help exposes separate history-fill and live composer-fill operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-help-"));
  try {
    const result = await runCli(["dev", "help"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_HOME: join(root, "codex"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/fill TOKENS");
    expect(result.stdout).toContain("/send-fill TOKENS");
    expect(result.stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV status reports the isolated home without creating a Codex route", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-status-"));
  const devHome = join(root, "dev");
  try {
    const result = await runCli(["dev", "status", "--json"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: devHome,
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
      CODEX_HOME: join(root, "production-codex"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      paths: {
        home: devHome,
        codexHome: join(devHome, "codex-home"),
        launcherUserData: join(devHome, "launcher"),
      },
      launcher: { running: false },
      config: { configured: false },
    });
    expect(existsSync(join(root, "production-codex", "config.toml"))).toBe(false);
    expect(existsSync(join(devHome, "codex-home", "config.toml"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV chat explains the isolated launcher setup when its profile is empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-empty-"));
  try {
    const result = await runCli(["dev", "chat", "smoke", "hello"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("In the window labelled DEV");
    expect(result.stderr).toContain("Complete optional MCP setup only for simulated tool rounds");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic --home cannot collapse DEV mode into another runtime home", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-home-"));
  try {
    const result = await runCli(["--home", join(root, "shared"), "dev", "status"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--home does not apply to DEV mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV browser-only setup persists only the isolated harness profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-setup-"));
  const devHome = join(root, "dev");
  const descriptorPath = join(devHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const controlToken = "dev-launcher-control-token-0123456789abcdefghijklmnop";
  let inspections = 0;
  const control = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    inspections += 1;
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe(`Bearer ${controlToken}`);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      proAvailable: false,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    control.once("error", rejectListen);
    control.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("control server has no port");
    mkdirSync(join(devHome, "runtime"), { recursive: true });
    writeFileSync(helperScript, "module.exports = {};\n", { mode: 0o700 });
    writeFileSync(descriptorPath, `${JSON.stringify({
      version: 2,
      kind: "codex-web-gpt-launcher",
      profile: "development",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48121",
      control: { endpoint: `http://127.0.0.1:${address.port}`, token: controlToken },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-dev-chatgpt",
      idleUrl: "about:blank#codex-web-gpt-browser-host",
      surfaceId: "d".repeat(32),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const result = await runCli([
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      descriptorPath,
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: devHome,
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
      CODEX_HOME: join(root, "production-codex"),
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("No Codex route, Responses listener, or system service was installed");
    expect(result.stdout).toContain("DEV launcher owns the isolated MCP tunnel");
    expect(inspections).toBe(1);
    expect(JSON.parse(readFileSync(join(devHome, "config.json"), "utf8"))).toMatchObject({
      version: 3,
      purpose: "dev-harness",
      mode: "browser-only",
      appName: "Codex Native2 DEV",
      browserHost: "launcher",
      browserHostDescriptorPath: descriptorPath,
      solAvailable: true,
      proAvailable: false,
    });
    expect(existsSync(join(root, "production-codex", "config.toml"))).toBe(false);
    expect(existsSync(join(devHome, "codex-home", "config.toml"))).toBe(false);
  } finally {
    await new Promise<void>(resolveClose => control.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider setup creates an owner-only API credential without changing the active Codex backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-provider-setup-"));
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  const descriptorPath = join(appHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const controlToken = "provider-launcher-control-token-0123456789abcdefghijkl";
  const originalCodexConfig = 'openai_base_url = "http://127.0.0.1:57204/v1"\nmodel = "gpt-5.6-sol"\n';
  const control = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the inspection request */ }
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe(`Bearer ${controlToken}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    control.once("error", rejectListen);
    control.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("control server has no port");
    mkdirSync(join(appHome, "runtime"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), originalCodexConfig);
    writeFileSync(helperScript, "module.exports = {};\n", { mode: 0o700 });
    writeFileSync(descriptorPath, `${JSON.stringify({
      version: 2,
      kind: "codex-web-gpt-launcher",
      profile: "production",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48120",
      control: { endpoint: `http://127.0.0.1:${address.port}`, token: controlToken },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: "about:blank#codex-web-gpt-browser-host",
      surfaceId: "p".repeat(32),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const result = await runCli([
      "setup",
      "--browser-only",
      "--provider-mode",
      "--port",
      String(20_000 + Math.floor(Math.random() * 20_000)),
      "--browser-host-descriptor",
      descriptorPath,
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
      CODEX_HOME: codexHome,
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Provider API configured");
    expect(result.stdout).not.toContain("Restart the Codex app");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(originalCodexConfig);
    expect(existsSync(join(appHome, "codex", "integration-journal.json"))).toBe(false);
    expect(existsSync(join(appHome, "codex", "integration-journal.recovery.json"))).toBe(false);
    expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
    const config = JSON.parse(readFileSync(join(appHome, "config.json"), "utf8"));
    expect(config).toMatchObject({
      providerApi: { enabled: true, apiKeyFile: join(appHome, "secrets", "provider-api.key") },
      browserHost: "launcher",
      solAvailable: true,
      proAvailable: true,
    });
    expect(config.providerApi.apiKey).toBeUndefined();
    expect(readFileSync(config.providerApi.apiKeyFile, "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    if (process.platform !== "win32") expect(statSync(config.providerApi.apiKeyFile).mode & 0o777).toBe(0o600);
  } finally {
    await new Promise<void>(resolveClose => control.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal uninstall refuses to race a launcher-owned runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-uninstall-"));
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: join(appHome, "runtime", "launcher-browser.json"),
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "launcher-uninstall-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be removed from Codex Web GPT Settings");
    expect(existsSync(configPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized launcher uninstall does not re-probe an already stopped full runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-launcher-uninstall-"));
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  const descriptorPath = join(appHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const runtimeKeyFile = join(appHome, "secrets", "runtime.key");
  const token = "launcher-uninstall-control-token-0123456789abcdef";
  mkdirSync(join(appHome, "runtime"), { recursive: true });
  mkdirSync(join(appHome, "secrets"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(helperScript, "module.exports = {};\n");
  writeFileSync(runtimeKeyFile, "test-key\n");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 2,
    kind: "codex-web-gpt-launcher",
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:48111",
    control: { endpoint: "http://127.0.0.1:48112", token },
    helper: { executable: process.execPath, script: helperScript },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "a".repeat(32),
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "full",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "runtime-control-token-0123456789abcdef0123456789",
    runtimeCommand: [process.execPath],
    tunnel: {
      binaryPath: join(root, "missing-tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
      profileDir: join(appHome, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
      "--launcher-control",
    ], {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CHATGPT_WEB_HOME: appHome,
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptorPath,
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token,
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Uninstalled and removed private application data");
    expect(existsSync(appHome)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accounts login persists the successful direct Chrome identity and enables the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-account-login-"));
  const appHome = join(root, "app");
  const preload = join(root, "login-preload.ts");
  const slotStorage = join(appHome, "browser", "slots", "slot_one", "storage-state.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: [{ id: "account_one", name: "Account", credentialId: "primary" }],
    credentials: [],
    slots: [{
      id: "slot_one",
      accountId: "account_one",
      label: "Workspace 1",
      storageStatePath: slotStorage,
      credentialId: "primary",
    }],
  }))}\n`);
  saveRotationState({
    nextIndex: 0,
    cooldowns: { slot_one: Date.now() + 600_000, slot_other: Date.now() + 600_000 },
  }, appHome);
  writeFileSync(preload, `
    import { mock } from "bun:test";
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const original = await import(${JSON.stringify(resolve(import.meta.dir, "../src/browser-login.ts"))});
    mock.module(${JSON.stringify(resolve(import.meta.dir, "../src/browser-login.ts"))}, () => ({
      ...original,
      loginToChatGpt: async (config) => {
        const configPath = join(process.env.CODEX_CHATGPT_WEB_HOME, "config.json");
        const concurrent = JSON.parse(readFileSync(configPath, "utf8"));
        concurrent.appName = "Concurrent App Name";
        writeFileSync(configPath, JSON.stringify(concurrent));
        return {
          storageStatePath: config.storageStatePath,
          accountSurfaceUrl: "https://chatgpt.com/",
          solAvailable: true,
          proAvailable: false,
          email: "person@example.com",
          workspaceName: "Team Workspace",
        };
      },
    }));
  `);
  try {
    const result = await runCli(["accounts", "login", "slot_one"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
    }, { preload });
    const saved = JSON.parse(readFileSync(join(appHome, "config.json"), "utf8"));

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(saved.accountRotation.accounts[0].email).toBe("person@example.com");
    expect(saved.appName).toBe("Concurrent App Name");
    expect(saved.accountRotation.slots[0]).toMatchObject({
      signedIn: true,
      chatgptWorkspaceName: "Team Workspace",
    });
    expect(loadRotationState(appHome).cooldowns).toEqual({
      slot_other: expect.any(Number),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accounts login leaves the workspace disabled when direct Chrome login fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-account-login-fail-"));
  const appHome = join(root, "app");
  const preload = join(root, "login-preload.ts");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: [{ id: "account_one", name: "Account", credentialId: "primary" }],
    credentials: [],
    slots: [{
      id: "slot_one",
      accountId: "account_one",
      label: "Workspace 1",
      storageStatePath: join(appHome, "browser", "slots", "slot_one", "storage-state.json"),
      credentialId: "primary",
    }],
  }))}\n`);
  writeFileSync(preload, `
    import { mock } from "bun:test";
    const original = await import(${JSON.stringify(resolve(import.meta.dir, "../src/browser-login.ts"))});
    mock.module(${JSON.stringify(resolve(import.meta.dir, "../src/browser-login.ts"))}, () => ({
      ...original,
      loginToChatGpt: async () => { throw new Error("login failed"); },
    }));
  `);
  try {
    const result = await runCli(["accounts", "login", "slot_one"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
    }, { preload });
    const saved = JSON.parse(readFileSync(join(appHome, "config.json"), "utf8"));

    expect(result.exitCode).toBe(1);
    expect(saved.accountRotation.slots[0].signedIn).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accounts validate exits nonzero when any configured workspace is invalid", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-account-validate-"));
  const appHome = join(root, "app");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: [{ id: "account_one", name: "Account", credentialId: "primary" }],
    credentials: [],
    slots: [{
      id: "slot_one",
      accountId: "account_one",
      label: "Workspace 1",
      storageStatePath: join(appHome, "browser", "slots", "slot_one", "storage-state.json"),
      credentialId: "primary",
    }],
  }))}\n`);
  try {
    const result = await runCli(["accounts", "validate"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit signed-in identity refresh clears only that workspace cooldown", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-account-refresh-"));
  const appHome = join(root, "app");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: [
      { id: "account_one", name: "One", credentialId: "primary" },
      { id: "account_other", name: "Other", credentialId: "primary" },
    ],
    credentials: [],
    slots: [
      { id: "slot_one", accountId: "account_one", label: "One", storageStatePath: join(appHome, "browser", "slots", "slot_one", "storage-state.json"), credentialId: "primary", signedIn: false },
      { id: "slot_other", accountId: "account_other", label: "Other", storageStatePath: join(appHome, "browser", "slots", "slot_other", "storage-state.json"), credentialId: "primary", signedIn: true },
    ],
  }))}\n`);
  saveRotationState({
    nextIndex: 1,
    cooldowns: { slot_one: Date.now() + 600_000, slot_other: Date.now() + 600_000 },
  }, appHome);
  try {
    const result = await runCli(["accounts", "update-identity", "slot_one", "--signed-in"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    const saved = JSON.parse(readFileSync(join(appHome, "config.json"), "utf8"));

    expect(result.exitCode).toBe(0);
    expect(saved.accountRotation.slots.find((slot: { id: string }) => slot.id === "slot_one").signedIn).toBe(true);
    expect(loadRotationState(appHome)).toEqual({
      nextIndex: 1,
      cooldowns: { slot_other: expect.any(Number) },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit signed-out identity refresh clears only that workspace login marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-account-signed-out-"));
  const appHome = join(root, "app");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: [
      { id: "account_one", name: "One", credentialId: "primary" },
      { id: "account_other", name: "Other", credentialId: "primary" },
    ],
    credentials: [],
    slots: [
      { id: "slot_one", accountId: "account_one", label: "One", storageStatePath: join(appHome, "browser", "slots", "slot_one", "storage-state.json"), credentialId: "primary", signedIn: true },
      { id: "slot_other", accountId: "account_other", label: "Other", storageStatePath: join(appHome, "browser", "slots", "slot_other", "storage-state.json"), credentialId: "primary", signedIn: true },
    ],
  }))}\n`);
  try {
    const result = await runCli(["accounts", "update-identity", "slot_one", "--signed-out"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    const saved = JSON.parse(readFileSync(join(appHome, "config.json"), "utf8"));

    expect(result.exitCode).toBe(0);
    expect(saved.accountRotation.slots.find((slot: { id: string }) => slot.id === "slot_one").signedIn).toBe(false);
    expect(saved.accountRotation.slots.find((slot: { id: string }) => slot.id === "slot_other").signedIn).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent account identity writers preserve every workspace update", async () => {
  if (process.env.CODEX_SKIP_PROCESS_CONCURRENCY_TESTS === "1") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-account-concurrent-"));
  const appHome = join(root, "app");
  mkdirSync(appHome, { recursive: true });
  // Keep a real Windows multi-process race without triggering Bun 1.4.0's high fan-out crash.
  const writerCount = process.platform === "win32" ? 4 : 12;
  const slots = Array.from({ length: writerCount }, (_, index) => ({
    id: `slot_${index}`,
    accountId: `account_${index}`,
    label: `Workspace ${index}`,
    storageStatePath: join(appHome, "browser", "slots", `slot_${index}`, "storage-state.json"),
    credentialId: "primary",
    signedIn: false,
  }));
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: slots.map((slot, index) => ({
      id: slot.accountId,
      name: `Account ${index}`,
      credentialId: "primary",
    })),
    credentials: [],
    slots,
  }))}\n`);
  try {
    const results = await Promise.all(slots.map(slot => runCli(
      ["accounts", "update-identity", slot.id, "--signed-in"],
      { ...process.env, CODEX_CHATGPT_WEB_HOME: appHome },
    )));
    expect(results.every(result => result.exitCode === 0)).toBeTrue();
    const saved = JSON.parse(readFileSync(join(appHome, "config.json"), "utf8"));
    expect(saved.accountRotation.slots.filter((slot: { signedIn?: boolean }) => slot.signedIn === true)).toHaveLength(slots.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account removal deletes only unreferenced app-owned storage and runtime keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-account-remove-"));
  const appHome = join(root, "app");
  const slotPath = (id: string) => join(appHome, "browser", "slots", id, "storage-state.json");
  const sharedKey = join(appHome, "secrets", "runtime-key-cred_shared.key");
  const uniqueKey = join(appHome, "secrets", "runtime-key-cred_unique.key");
  const externalKey = join(root, "external.key");
  const primaryStorage = join(appHome, "browser", "storage-state.json");
  const primaryKey = join(appHome, "secrets", "runtime-key-primary.key");
  for (const path of [primaryStorage, slotPath("slot_a"), slotPath("slot_b"), slotPath("slot_c"), slotPath("slot_d"), sharedKey, uniqueKey, externalKey, primaryKey]) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "test\n", { mode: 0o600 });
  }
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: [
      { id: "account_primary", name: "Primary", credentialId: "primary" },
      { id: "account_a", name: "A", credentialId: "cred_shared" },
      { id: "account_b", name: "B", credentialId: "cred_shared" },
      { id: "account_c", name: "C", credentialId: "cred_unique" },
      { id: "account_d", name: "D", credentialId: "cred_external" },
    ],
    credentials: [
      { id: "primary", tunnelId: `tunnel_${"a".repeat(32)}`, runtimeKeyFile: primaryKey, alias: "primary", profileName: "profile" },
      { id: "cred_shared", tunnelId: `tunnel_${"b".repeat(32)}`, runtimeKeyFile: sharedKey, alias: "shared", profileName: "profile" },
      { id: "cred_unique", tunnelId: `tunnel_${"c".repeat(32)}`, runtimeKeyFile: uniqueKey, alias: "unique", profileName: "profile" },
      { id: "cred_external", tunnelId: `tunnel_${"d".repeat(32)}`, runtimeKeyFile: externalKey, alias: "external", profileName: "profile" },
    ],
    slots: [
      { id: "primary", accountId: "account_primary", label: "Primary", storageStatePath: primaryStorage, credentialId: "primary", signedIn: true },
      { id: "slot_a", accountId: "account_a", label: "A", storageStatePath: slotPath("slot_a"), credentialId: "cred_shared", signedIn: true },
      { id: "slot_b", accountId: "account_b", label: "B", storageStatePath: slotPath("slot_b"), credentialId: "cred_shared", signedIn: true },
      { id: "slot_c", accountId: "account_c", label: "C", storageStatePath: slotPath("slot_c"), credentialId: "cred_unique", signedIn: true },
      { id: "slot_d", accountId: "account_d", label: "D", storageStatePath: slotPath("slot_d"), credentialId: "cred_external", signedIn: true },
    ],
  }))}\n`);
  try {
    for (const accountId of ["account_a", "account_c", "account_d"]) {
      const result = await runCli(["accounts", "remove-account", accountId], {
        ...process.env,
        CODEX_CHATGPT_WEB_HOME: appHome,
      });
      expect(result.exitCode).toBe(0);
    }

    expect(existsSync(resolve(slotPath("slot_a"), ".."))).toBe(false);
    expect(existsSync(resolve(slotPath("slot_c"), ".."))).toBe(false);
    expect(existsSync(resolve(slotPath("slot_d"), ".."))).toBe(false);
    expect(existsSync(sharedKey)).toBe(true);
    expect(existsSync(uniqueKey)).toBe(false);
    expect(existsSync(externalKey)).toBe(true);
    expect(existsSync(primaryStorage)).toBe(true);
    expect(existsSync(primaryKey)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace removal deletes its unreferenced app-owned storage and runtime key", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-slot-remove-"));
  const appHome = join(root, "app");
  const storageDir = join(appHome, "browser", "slots", "slot_x");
  const storageStatePath = join(storageDir, "storage-state.json");
  const runtimeKeyFile = join(appHome, "secrets", "runtime-key-cred_x.key");
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(resolve(runtimeKeyFile, ".."), { recursive: true });
  writeFileSync(storageStatePath, "{}\n", { mode: 0o600 });
  writeFileSync(runtimeKeyFile, "test\n", { mode: 0o600 });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(browserOnlyConfig(appHome, {
    accounts: [{ id: "account_x", name: "X", credentialId: "cred_x" }],
    credentials: [{
      id: "cred_x",
      tunnelId: `tunnel_${"e".repeat(32)}`,
      runtimeKeyFile,
      alias: "account-x",
      profileName: "profile",
    }],
    slots: [{
      id: "slot_x",
      accountId: "account_x",
      label: "X",
      storageStatePath,
      credentialId: "cred_x",
      signedIn: true,
    }],
  }))}\n`);
  try {
    const result = await runCli(["accounts", "remove", "slot_x"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(storageDir)).toBe(false);
    expect(existsSync(runtimeKeyFile)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
