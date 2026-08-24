import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { sanitizeChatGptWorkspaceName } from "./chatgpt-identity";
import { withFileMutationLock } from "./file-lock";

interface RotationHostConfig {
  storageStatePath: string;
  tunnel?: {
    tunnelId: string;
    runtimeKeyFile: string;
    alias: string;
    profileName: string;
  };
  accountRotation?: AccountRotationConfig;
}

function getConfigDir(): string {
  const configured = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  if (configured) return resolve(configured);
  return resolve(join(homedir(), ".codex-chatgpt-web"));
}

export const ACCOUNT_ROTATION_COOLDOWN_MS = 10 * 60_000;
export const ACCOUNT_ROTATION_KEEPALIVE_MS = 8 * 60_000;
export const PRIMARY_ACCOUNT_SLOT_ID = "primary";
export const PRIMARY_ACCOUNT_ID = "account_primary";
export const PRIMARY_CREDENTIAL_ID = "primary";
export const NO_ACCOUNT_SLOTS_MESSAGE =
  "Sign in to at least one ChatGPT account in Codex Web GPT → Settings → Accounts before using ChatGPT Web models.";

export interface AccountRecord {
  id: string;
  name: string;
  email?: string;
  credentialId: string;
}

export interface AccountCredential {
  id: string;
  tunnelId: string;
  runtimeKeyFile: string;
  alias: string;
  profileName: string;
}

export interface AccountSlot {
  id: string;
  accountId: string;
  label: string;
  chatgptWorkspaceName?: string;
  signedIn?: boolean;
  storageStatePath: string;
  credentialId: string;
}

export interface AccountRotationConfig {
  accounts: AccountRecord[];
  slots: AccountSlot[];
  credentials: AccountCredential[];
}

export interface AccountRotationState {
  nextIndex: number;
  cooldowns: Record<string, number>;
}

export interface SelectedAccountSlot {
  slot: AccountSlot;
  credential: AccountCredential | undefined;
  partition: string;
}

const SAFE_ROTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function rotationStatePath(home = getConfigDir()): string {
  return join(home, "runtime", "account-rotation-state.json");
}

function withRotationStateLock<T>(home: string, action: () => T): T {
  const runtimeDir = join(home, "runtime");
  const lockPath = join(runtimeDir, ".account-rotation-state.lock");
  return withFileMutationLock(lockPath, "Timed out waiting to update ChatGPT account rotation state", action);
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function launcherPartitionForSlot(
  slotId: string,
  profile: "production" | "development" = "production",
): string {
  const base = profile === "development"
    ? "persist:codex-web-gpt-dev-chatgpt"
    : "persist:codex-web-gpt-chatgpt";
  return slotId === PRIMARY_ACCOUNT_SLOT_ID ? base : `${base}-${slotId}`;
}

export function emptyRotationState(): AccountRotationState {
  return { nextIndex: 0, cooldowns: {} };
}

export function loadRotationState(home = getConfigDir()): AccountRotationState {
  const path = rotationStatePath(home);
  if (!existsSync(path)) return emptyRotationState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AccountRotationState>;
    const nextIndex = Number.isInteger(parsed.nextIndex) && (parsed.nextIndex ?? 0) >= 0
      ? parsed.nextIndex!
      : 0;
    const cooldowns: Record<string, number> = {};
    if (parsed.cooldowns && typeof parsed.cooldowns === "object" && !Array.isArray(parsed.cooldowns)) {
      for (const [id, until] of Object.entries(parsed.cooldowns)) {
        if (typeof until === "number" && Number.isFinite(until)) cooldowns[id] = until;
      }
    }
    return { nextIndex, cooldowns };
  } catch {
    return emptyRotationState();
  }
}

export function saveRotationState(state: AccountRotationState, home = getConfigDir()): void {
  const path = rotationStatePath(home);
  mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function primaryCredentialFromTunnel(tunnel: RotationHostConfig["tunnel"]): AccountCredential | undefined {
  if (!tunnel) return undefined;
  return {
    id: PRIMARY_CREDENTIAL_ID,
    tunnelId: tunnel.tunnelId,
    runtimeKeyFile: tunnel.runtimeKeyFile,
    alias: tunnel.alias,
    profileName: tunnel.profileName,
  };
}

export function primaryAccountFromConfig(): AccountRecord {
  return {
    id: PRIMARY_ACCOUNT_ID,
    name: "Primary",
    credentialId: PRIMARY_CREDENTIAL_ID,
  };
}

export function primarySlotFromConfig(config: RotationHostConfig): AccountSlot {
  return {
    id: PRIMARY_ACCOUNT_SLOT_ID,
    accountId: PRIMARY_ACCOUNT_ID,
    label: "Primary",
    signedIn: true,
    storageStatePath: config.storageStatePath,
    credentialId: PRIMARY_CREDENTIAL_ID,
  };
}

export function rotationFromConfig(config: RotationHostConfig): AccountRotationConfig {
  if (config.accountRotation) {
    return normalizeRotation(config.accountRotation);
  }
  return {
    accounts: [primaryAccountFromConfig()],
    slots: [primarySlotFromConfig(config)],
    credentials: primaryCredentialFromTunnel(config.tunnel) ? [primaryCredentialFromTunnel(config.tunnel)!] : [],
  };
}

export function normalizeRotation(rotation: AccountRotationConfig): AccountRotationConfig {
  const credentials = [...rotation.credentials];
  const slots = rotation.slots.map(slot => ({
    ...slot,
    accountId: slot.accountId || (slot.credentialId === PRIMARY_CREDENTIAL_ID ? PRIMARY_ACCOUNT_ID : `account_${slot.credentialId}`),
  }));
  const accounts = rotation.accounts?.length
    ? rotation.accounts
    : [...new Map(slots.map(slot => [slot.accountId, {
      id: slot.accountId,
      name: slot.accountId === PRIMARY_ACCOUNT_ID ? "Primary" : slot.label,
      credentialId: slot.credentialId,
    } as AccountRecord])).values()];
  return { accounts, slots, credentials };
}

export function uniqueCredentials(rotation: AccountRotationConfig): AccountCredential[] {
  const seen = new Set<string>();
  const unique: AccountCredential[] = [];
  for (const credential of rotation.credentials) {
    const key = `${credential.tunnelId}:${credential.runtimeKeyFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(credential);
  }
  return unique;
}

export function credentialForSlot(
  rotation: AccountRotationConfig,
  slot: AccountSlot,
): AccountCredential | undefined {
  return rotation.credentials.find(candidate => candidate.id === slot.credentialId);
}

export function parseAccountRotation(value: unknown, path: string): AccountRotationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid accountRotation in ${path}`);
  }
  const parsed = value as Partial<AccountRotationConfig>;
  if (!Array.isArray(parsed.slots)) {
    throw new Error(`accountRotation.slots must be an array in ${path}`);
  }
  if (!Array.isArray(parsed.credentials)) {
    throw new Error(`accountRotation.credentials must be an array in ${path}`);
  }
  const credentials: AccountCredential[] = parsed.credentials.map((credential, index) => {
    if (!credential || typeof credential !== "object") throw new Error(`Invalid credential ${index} in ${path}`);
    for (const key of ["id", "tunnelId", "runtimeKeyFile", "alias", "profileName"] as const) {
      if (typeof credential[key] !== "string" || !credential[key].trim()) {
        throw new Error(`Missing accountRotation.credentials[${index}].${key} in ${path}`);
      }
    }
    if (!SAFE_ROTATION_ID.test(credential.id.trim())) {
      throw new Error(`Invalid accountRotation.credentials[${index}].id in ${path}`);
    }
    for (const key of ["alias", "profileName"] as const) {
      if (!SAFE_ROTATION_ID.test(credential[key])) {
        throw new Error(`Invalid accountRotation.credentials[${index}].${key} in ${path}`);
      }
    }
    if (!isAbsolute(credential.runtimeKeyFile)) {
      throw new Error(`accountRotation.credentials[${index}].runtimeKeyFile must be absolute in ${path}`);
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(credential.tunnelId)) {
      throw new Error(`Invalid accountRotation.credentials[${index}].tunnelId in ${path}`);
    }
    return {
      id: credential.id.trim(),
      tunnelId: credential.tunnelId,
      runtimeKeyFile: credential.runtimeKeyFile,
      alias: credential.alias,
      profileName: credential.profileName,
    };
  });
  const credentialIds = new Set(credentials.map(credential => credential.id));
  if (credentialIds.size !== credentials.length) {
    throw new Error(`Duplicate accountRotation credential ids in ${path}`);
  }
  const slots: AccountSlot[] = parsed.slots.map((slot, index) => {
    if (!slot || typeof slot !== "object") throw new Error(`Invalid slot ${index} in ${path}`);
    for (const key of ["id", "label", "storageStatePath", "credentialId"] as const) {
      if (typeof slot[key] !== "string" || !slot[key].trim()) {
        throw new Error(`Missing accountRotation.slots[${index}].${key} in ${path}`);
      }
    }
    if (!SAFE_ROTATION_ID.test(slot.id.trim())) {
      throw new Error(`Invalid accountRotation.slots[${index}].id in ${path}`);
    }
    if (!isAbsolute(slot.storageStatePath)) {
      throw new Error(`accountRotation.slots[${index}].storageStatePath must be absolute in ${path}`);
    }
    if (!credentialIds.has(slot.credentialId) && slot.credentialId !== PRIMARY_CREDENTIAL_ID) {
      throw new Error(`accountRotation.slots[${index}] references unknown credential ${JSON.stringify(slot.credentialId)} in ${path}`);
    }
    return {
      id: slot.id.trim(),
      accountId: typeof slot.accountId === "string" && slot.accountId.trim()
        ? slot.accountId.trim()
        : (slot.credentialId === PRIMARY_CREDENTIAL_ID ? PRIMARY_ACCOUNT_ID : `account_${slot.credentialId.trim()}`),
      label: slot.label.trim(),
      ...(typeof slot.chatgptWorkspaceName === "string" && slot.chatgptWorkspaceName.trim()
        ? { chatgptWorkspaceName: slot.chatgptWorkspaceName.trim() }
        : {}),
      ...(typeof slot.signedIn === "boolean" ? { signedIn: slot.signedIn } : {}),
      storageStatePath: slot.storageStatePath,
      credentialId: slot.credentialId.trim(),
    };
  });
  if (new Set(slots.map(slot => slot.id)).size !== slots.length) {
    throw new Error(`Duplicate accountRotation slot ids in ${path}`);
  }
  const parsedAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  const accounts: AccountRecord[] = parsedAccounts.length > 0
    ? parsedAccounts.map((account, index) => {
      if (!account || typeof account !== "object") throw new Error(`Invalid account ${index} in ${path}`);
      if (typeof account.id !== "string" || !account.id.trim()) throw new Error(`Missing accountRotation.accounts[${index}].id in ${path}`);
      if (typeof account.name !== "string" || !account.name.trim()) throw new Error(`Missing accountRotation.accounts[${index}].name in ${path}`);
      if (typeof account.credentialId !== "string" || !account.credentialId.trim()) {
        throw new Error(`Missing accountRotation.accounts[${index}].credentialId in ${path}`);
      }
      if (!SAFE_ROTATION_ID.test(account.id.trim())) {
        throw new Error(`Invalid accountRotation.accounts[${index}].id in ${path}`);
      }
      return {
        id: account.id.trim(),
        name: account.name.trim(),
        credentialId: account.credentialId.trim(),
        ...(typeof account.email === "string" && account.email.trim() ? { email: account.email.trim() } : {}),
      };
    })
    : [...new Map(slots.map(slot => [slot.accountId, {
      id: slot.accountId,
      name: slot.accountId === PRIMARY_ACCOUNT_ID ? "Primary" : slot.label,
      credentialId: slot.credentialId,
    } as AccountRecord])).values()];
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) {
    throw new Error(`Duplicate accountRotation account ids in ${path}`);
  }
  const accountsById = new Map(accounts.map(account => [account.id, account]));
  for (const [index, account] of accounts.entries()) {
    if (!SAFE_ROTATION_ID.test(account.id)) {
      throw new Error(`Invalid accountRotation account id ${JSON.stringify(account.id)} in ${path}`);
    }
    if (!credentialIds.has(account.credentialId) && account.credentialId !== PRIMARY_CREDENTIAL_ID) {
      throw new Error(`accountRotation.accounts[${index}] references unknown credential ${JSON.stringify(account.credentialId)} in ${path}`);
    }
    if (!slots.some(slot => slot.accountId === account.id)) {
      throw new Error(`accountRotation.accounts[${index}] has no workspaces in ${path}`);
    }
  }
  for (const [index, slot] of slots.entries()) {
    const account = accountsById.get(slot.accountId);
    if (!account) {
      throw new Error(`accountRotation.slots[${index}] references unknown account ${JSON.stringify(slot.accountId)} in ${path}`);
    }
    if (slot.credentialId !== account.credentialId) {
      throw new Error(`accountRotation.slots[${index}] credential does not match account ${JSON.stringify(slot.accountId)} in ${path}`);
    }
  }
  return { accounts, slots, credentials };
}

export function availableSlots(
  rotation: AccountRotationConfig,
  state: AccountRotationState,
  now = Date.now(),
  eligible: (slot: AccountSlot) => boolean = () => true,
): AccountSlot[] {
  return rotation.slots.filter(slot => eligible(slot) && (state.cooldowns[slot.id] ?? 0) <= now);
}

export function pickNextSlot(
  rotation: AccountRotationConfig,
  state: AccountRotationState,
  now = Date.now(),
  eligible: (slot: AccountSlot) => boolean = () => true,
): { selected: SelectedAccountSlot; state: AccountRotationState } {
  if (rotation.slots.length === 0) {
    throw new Error(NO_ACCOUNT_SLOTS_MESSAGE);
  }
  const eligibleSlots = rotation.slots.filter(eligible);
  if (eligibleSlots.length === 0) throw new Error(NO_ACCOUNT_SLOTS_MESSAGE);
  const available = availableSlots(rotation, state, now, eligible);
  if (available.length === 0) {
    const soonest = Math.min(...eligibleSlots.map(slot => state.cooldowns[slot.id] ?? 0));
    const waitMs = Math.max(0, soonest - now);
    const waitMin = Math.ceil(waitMs / 60_000);
    throw new Error(
      `Every ChatGPT account is cooling down after a rate limit. Wait about ${waitMin || 1} minute(s), then retry.`,
    );
  }
  const startIndex = state.nextIndex % rotation.slots.length;
  let selectedIndex = -1;
  for (let offset = 0; offset < rotation.slots.length; offset += 1) {
    const index = (startIndex + offset) % rotation.slots.length;
    if (eligible(rotation.slots[index]!) && (state.cooldowns[rotation.slots[index]!.id] ?? 0) <= now) {
      selectedIndex = index;
      break;
    }
  }
  const slot = rotation.slots[selectedIndex]!;
  const nextState: AccountRotationState = {
    nextIndex: (selectedIndex + 1) % rotation.slots.length,
    cooldowns: { ...state.cooldowns },
  };
  return {
    selected: {
      slot,
      credential: credentialForSlot(rotation, slot),
      partition: launcherPartitionForSlot(slot.id),
    },
    state: nextState,
  };
}

export function markSlotCooldown(
  state: AccountRotationState,
  slotId: string,
  now = Date.now(),
  durationMs = ACCOUNT_ROTATION_COOLDOWN_MS,
): AccountRotationState {
  return {
    ...state,
    cooldowns: { ...state.cooldowns, [slotId]: now + durationMs },
  };
}

export function slotStorageDir(slotId: string, home = getConfigDir()): string {
  return join(home, "browser", "slots", slotId);
}

export function addAccountSlot(
  config: RotationHostConfig,
  input: {
    label: string;
    reuseCredentialId?: string;
    tunnelId?: string;
    runtimeKeyFile?: string;
    asNewAccount?: boolean;
    accountId?: string;
    workspaceName?: string;
  },
): { config: RotationHostConfig; slot: AccountSlot } {
  const label = input.label.trim();
  if (!label || label.length > 80) throw new Error("Account label is invalid");
  const rotation = rotationFromConfig(config);
  const id = newId("slot");
  let credentialId = input.reuseCredentialId?.trim();
  let credentials = [...rotation.credentials];
  if (credentialId) {
    if (!credentials.some(credential => credential.id === credentialId)
      && credentialId !== PRIMARY_CREDENTIAL_ID) {
      throw new Error(`Unknown credential ${JSON.stringify(credentialId)}`);
    }
    if (credentialId === PRIMARY_CREDENTIAL_ID && !credentials.some(credential => credential.id === PRIMARY_CREDENTIAL_ID)) {
      const primary = primaryCredentialFromTunnel(config.tunnel);
      if (!primary) throw new Error("Primary tunnel credentials are not configured");
      credentials = [primary, ...credentials];
    }
  } else {
    const tunnelId = input.tunnelId?.trim();
    const runtimeKeyFile = input.runtimeKeyFile?.trim();
    if (!tunnelId || !runtimeKeyFile) {
      throw new Error("New accounts need --tunnel-id and --runtime-key-file, or --reuse-credentials");
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
      throw new Error("Tunnel id must be tunnel_ followed by 32 lowercase hexadecimal characters");
    }
    const resolved = resolveCredential(credentials, {
      tunnelId,
      runtimeKeyFile,
      profileName: config.tunnel?.profileName || "codex-chatgpt-web",
    }, primaryCredentialFromTunnel(config.tunnel));
    credentialId = resolved.credential.id;
    credentials = resolved.credentials;
  }
  const slots = [...rotation.slots];
  let accounts = [...rotation.accounts];
  let account = input.accountId
    ? accounts.find(candidate => candidate.id === input.accountId)
    : input.asNewAccount
      ? undefined
      : accounts.find(candidate => candidate.credentialId === credentialId);
  if (input.accountId && !account) throw new Error(`Unknown account ${JSON.stringify(input.accountId)}`);
  if (!account) {
    account = {
      id: newId("account"),
      name: label,
      credentialId: credentialId!,
    };
    accounts = [...accounts, account];
  }
  const workspaceName = input.asNewAccount
    ? (input.workspaceName?.trim() || "Workspace 1")
    : label;
  const slot: AccountSlot = {
    id,
    accountId: account.id,
    label: workspaceName,
    storageStatePath: join(slotStorageDir(id), "storage-state.json"),
    credentialId: credentialId!,
  };
  mkdirSync(slotStorageDir(id), { recursive: true, mode: 0o700 });
  const next = {
    ...config,
    accountRotation: { accounts, slots: [...slots, slot], credentials },
  };
  return { config: next, slot };
}

export function addWorkspaceToAccount(
  config: RotationHostConfig,
  input: { accountId: string; name?: string },
): { config: RotationHostConfig; slot: AccountSlot } {
  const rotation = rotationFromConfig(config);
  const account = rotation.accounts.find(candidate => candidate.id === input.accountId);
  if (!account) throw new Error(`Unknown account ${JSON.stringify(input.accountId)}`);
  const count = rotation.slots.filter(slot => slot.accountId === account.id).length;
  return addAccountSlot(config, {
    label: input.name?.trim() || `Workspace ${count + 1}`,
    reuseCredentialId: account.credentialId,
    accountId: account.id,
  });
}

export function renameAccountRecord(
  config: RotationHostConfig,
  accountId: string,
  name: string,
): RotationHostConfig {
  const label = name.trim();
  if (!label || label.length > 80) throw new Error("Account name is invalid");
  const rotation = rotationFromConfig(config);
  if (!rotation.accounts.some(account => account.id === accountId)) {
    throw new Error(`Unknown account ${JSON.stringify(accountId)}`);
  }
  return {
    ...config,
    accountRotation: {
      ...rotation,
      accounts: rotation.accounts.map(account => account.id === accountId ? { ...account, name: label } : account),
    },
  };
}

export function renameWorkspaceSlot(
  config: RotationHostConfig,
  slotId: string,
  name: string,
): RotationHostConfig {
  const label = name.trim();
  if (!label || label.length > 80) throw new Error("Workspace name is invalid");
  const rotation = rotationFromConfig(config);
  if (!rotation.slots.some(slot => slot.id === slotId)) {
    throw new Error(`Unknown account slot ${JSON.stringify(slotId)}`);
  }
  return {
    ...config,
    accountRotation: {
      ...rotation,
      slots: rotation.slots.map(slot => slot.id === slotId ? { ...slot, label } : slot),
    },
  };
}

export function updateAccountIdentity(
  config: RotationHostConfig,
  slotId: string,
  identity: { email?: string; workspaceName?: string; signedIn?: boolean },
): RotationHostConfig {
  const rotation = rotationFromConfig(config);
  const slot = rotation.slots.find(candidate => candidate.id === slotId);
  if (!slot) throw new Error(`Unknown account slot ${JSON.stringify(slotId)}`);
  const signedIn = typeof identity.signedIn === "boolean"
    ? identity.signedIn
    : identity.email || identity.workspaceName
      ? true
      : slot.signedIn;
  const workspaceName = sanitizeChatGptWorkspaceName(identity.workspaceName);
  return {
    ...config,
    accountRotation: {
      ...rotation,
      accounts: rotation.accounts.map(account => (
        account.id === slot.accountId && identity.email
          ? { ...account, email: identity.email }
          : account
      )),
      slots: rotation.slots.map(candidate => (
        candidate.id === slotId
          ? {
            ...candidate,
            ...(typeof signedIn === "boolean" ? { signedIn } : {}),
            ...(workspaceName ? { chatgptWorkspaceName: workspaceName } : {}),
          }
          : candidate
      )),
    },
  };
}

export function presentAccounts(rotation: AccountRotationConfig, profile: "production" | "development" = "production") {
  return rotation.accounts.map(account => ({
    id: account.id,
    name: account.name,
    email: account.email,
    credentialId: account.credentialId,
    workspaces: rotation.slots.filter(slot => slot.accountId === account.id).map(slot => ({
      id: slot.id,
      name: slot.label,
      chatgptWorkspaceName: sanitizeChatGptWorkspaceName(slot.chatgptWorkspaceName),
      signedIn: slot.signedIn === true,
      partition: launcherPartitionForSlot(slot.id, profile),
      credentialId: slot.credentialId,
    })),
  }));
}

export function claimAccountSlot(
  config: RotationHostConfig,
  now = Date.now(),
): SelectedAccountSlot {
  const home = getConfigDir();
  return withRotationStateLock(home, () => {
    const rotation = rotationFromConfig(config);
    const picked = pickNextSlot(
      rotation,
      loadRotationState(home),
      now,
      config.accountRotation ? slot => slot.signedIn === true : undefined,
    );
    saveRotationState(picked.state, home);
    return picked.selected;
  });
}

export function coolAccountSlot(slotId: string, now = Date.now()): void {
  const home = getConfigDir();
  withRotationStateLock(home, () => {
    saveRotationState(markSlotCooldown(loadRotationState(home), slotId, now), home);
  });
}

export function clearAccountSlotCooldown(slotId: string, home = getConfigDir()): void {
  withRotationStateLock(home, () => {
    const state = loadRotationState(home);
    if (!(slotId in state.cooldowns)) return;
    const cooldowns = { ...state.cooldowns };
    delete cooldowns[slotId];
    saveRotationState({ ...state, cooldowns }, home);
  });
}

function runtimeKeyFingerprint(runtimeKeyFile: string): string {
  if (!existsSync(runtimeKeyFile)) return `missing:${runtimeKeyFile}`;
  return createHash("sha256").update(readFileSync(runtimeKeyFile)).digest("hex");
}

function storeRuntimeKey(credentialId: string, runtimeKeyFile: string): string {
  if (!existsSync(runtimeKeyFile)) return runtimeKeyFile;
  const storedKey = join(getConfigDir(), "secrets", `runtime-key-${credentialId}.key`);
  mkdirSync(join(getConfigDir(), "secrets"), { recursive: true, mode: 0o700 });
  copyFileSync(runtimeKeyFile, storedKey);
  return storedKey;
}

function resolveCredential(
  credentials: AccountCredential[],
  input: { tunnelId: string; runtimeKeyFile: string; profileName: string },
  primary?: AccountCredential,
): { credential: AccountCredential; credentials: AccountCredential[] } {
  const fingerprint = runtimeKeyFingerprint(input.runtimeKeyFile);
  const next = primary && !credentials.some(credential => credential.id === primary.id)
    ? [primary, ...credentials]
    : [...credentials];
  const existing = next.find(credential => (
    credential.tunnelId === input.tunnelId
    && runtimeKeyFingerprint(credential.runtimeKeyFile) === fingerprint
  ));
  if (existing) return { credential: existing, credentials: next };
  const sameTunnel = next.find(credential => credential.tunnelId === input.tunnelId);
  const id = newId("cred");
  const credential: AccountCredential = {
    id,
    tunnelId: input.tunnelId,
    runtimeKeyFile: storeRuntimeKey(id, input.runtimeKeyFile),
    alias: sameTunnel?.alias ?? `codex-chatgpt-web-${id}`,
    profileName: input.profileName,
  };
  return { credential, credentials: [...next, credential] };
}

export function runtimeAliasForCredential(
  config: RotationHostConfig,
  credential: AccountCredential,
): string {
  if (config.tunnel?.tunnelId === credential.tunnelId && config.tunnel.alias) {
    return config.tunnel.alias;
  }
  return credential.alias;
}

export function setSlotCredentials(
  config: RotationHostConfig,
  slotIds: string[],
  input: {
    reuseCredentialId?: string;
    tunnelId?: string;
    runtimeKeyFile?: string;
  },
): RotationHostConfig {
  const rotation = rotationFromConfig(config);
  const ids = [...new Set(slotIds.map(id => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("No account slots specified");
  for (const slotId of ids) {
    if (!rotation.slots.some(slot => slot.id === slotId)) {
      throw new Error(`Unknown account slot ${JSON.stringify(slotId)}`);
    }
  }
  let credentials = [...rotation.credentials];
  if (!credentials.some(credential => credential.id === PRIMARY_CREDENTIAL_ID)) {
    const primary = primaryCredentialFromTunnel(config.tunnel);
    if (primary) credentials = [primary, ...credentials];
  }
  let credentialId = input.reuseCredentialId?.trim();
  if (credentialId) {
    if (!credentials.some(credential => credential.id === credentialId)) {
      throw new Error(`Unknown credential ${JSON.stringify(credentialId)}`);
    }
  } else {
    const tunnelId = input.tunnelId?.trim() || config.tunnel?.tunnelId;
    const runtimeKeyFile = input.runtimeKeyFile?.trim();
    if (!tunnelId || !runtimeKeyFile) {
      throw new Error("set-credentials needs --runtime-key-file, and a tunnel id unless the primary tunnel is reused");
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
      throw new Error("Tunnel id must be tunnel_ followed by 32 lowercase hexadecimal characters");
    }
    const resolved = resolveCredential(credentials, {
      tunnelId,
      runtimeKeyFile,
      profileName: config.tunnel?.profileName || "codex-chatgpt-web",
    }, primaryCredentialFromTunnel(config.tunnel));
    credentialId = resolved.credential.id;
    credentials = resolved.credentials;
  }
  const selectedAccountIds = new Set(
    rotation.slots.filter(slot => ids.includes(slot.id)).map(slot => slot.accountId),
  );
  const slots = rotation.slots.map(slot => (
    selectedAccountIds.has(slot.accountId) ? { ...slot, credentialId: credentialId! } : slot
  ));
  const accounts = rotation.accounts.map(account => (
    selectedAccountIds.has(account.id) ? { ...account, credentialId: credentialId! } : account
  ));
  const used = new Set(slots.map(slot => slot.credentialId));
  return {
    ...config,
    accountRotation: {
      accounts,
      slots,
      credentials: credentials.filter(credential => used.has(credential.id) || credential.id === PRIMARY_CREDENTIAL_ID),
    },
  };
}

function pruneRotation(
  _config: RotationHostConfig,
  rotation: AccountRotationConfig,
): AccountRotationConfig {
  const usedAccounts = new Set(rotation.slots.map(slot => slot.accountId));
  const usedCredentials = new Set(rotation.slots.map(slot => slot.credentialId));
  return {
    accounts: rotation.accounts.filter(account => usedAccounts.has(account.id)),
    slots: rotation.slots,
    credentials: rotation.credentials.filter(credential => usedCredentials.has(credential.id)),
  };
}

export function removeAccountSlot(config: RotationHostConfig, slotId: string): RotationHostConfig {
  const rotation = rotationFromConfig(config);
  const slots = rotation.slots.filter(slot => slot.id !== slotId);
  if (slots.length === rotation.slots.length) throw new Error(`Unknown account slot ${JSON.stringify(slotId)}`);
  return { ...config, accountRotation: pruneRotation(config, { ...rotation, slots }) };
}

export function removeAccountRecord(config: RotationHostConfig, accountId: string): RotationHostConfig {
  const id = accountId.trim();
  const rotation = rotationFromConfig(config);
  if (!rotation.accounts.some(account => account.id === id)) {
    throw new Error(`Unknown account ${JSON.stringify(id)}`);
  }
  const slots = rotation.slots.filter(slot => slot.accountId !== id);
  const accounts = rotation.accounts.filter(account => account.id !== id);
  return { ...config, accountRotation: pruneRotation(config, { ...rotation, accounts, slots }) };
}

export function cleanupRemovedAccountArtifacts(
  before: RotationHostConfig,
  after: RotationHostConfig,
  home = getConfigDir(),
): void {
  const previous = rotationFromConfig(before);
  const remaining = rotationFromConfig(after);
  const remainingSlotIds = new Set(remaining.slots.map(slot => slot.id));

  for (const slot of previous.slots) {
    if (slot.id === PRIMARY_ACCOUNT_SLOT_ID || remainingSlotIds.has(slot.id)) continue;
    const storageDir = resolve(slotStorageDir(slot.id, home));
    if (resolve(slot.storageStatePath) !== join(storageDir, "storage-state.json")) continue;
    const stillReferenced = remaining.slots.some(candidate => {
      const storagePath = resolve(candidate.storageStatePath);
      return storagePath === storageDir || storagePath.startsWith(`${storageDir}${sep}`);
    });
    if (!stillReferenced) rmSync(storageDir, { recursive: true, force: true });
  }

  const remainingCredentialIds = new Set(remaining.credentials.map(credential => credential.id));
  for (const credential of previous.credentials) {
    if (credential.id === PRIMARY_CREDENTIAL_ID || remainingCredentialIds.has(credential.id)) continue;
    const managedKey = resolve(join(home, "secrets", `runtime-key-${credential.id}.key`));
    if (resolve(credential.runtimeKeyFile) !== managedKey) continue;
    const stillReferenced = remaining.credentials.some(candidate => resolve(candidate.runtimeKeyFile) === managedKey);
    if (!stillReferenced) rmSync(managedKey, { force: true });
  }
}
