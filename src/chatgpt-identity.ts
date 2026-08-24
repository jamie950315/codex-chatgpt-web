const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BLOCKED_EMAILS = new Set([
  "support@openai.com",
  "noreply@openai.com",
  "help@openai.com",
  "privacy@openai.com",
]);
const GENERIC_WORKSPACE_NAMES = new Set([
  "chatgpt",
  "new chat",
  "temporary chat",
  "search",
  "library",
  "gpts",
  "gpt",
  "sora",
  "settings",
  "log out",
  "logout",
  "help",
  "sidebar",
  "side bar",
  "business",
  "plus",
  "team",
  "pro",
  "personal",
  "free",
  "enterprise",
  "側邊欄",
  "侧边栏",
  "開啟側邊欄",
  "开启侧边栏",
  "關閉側邊欄",
  "关闭侧边栏",
  "新對話",
  "新对话",
  "暫存對話",
  "暂存对话",
  "專案",
  "项目",
  "排程",
  "资料库",
  "資料庫",
  "外掛程式",
  "插件",
  "智慧體",
  "智能体",
  "地圖",
  "地图",
  "邀請團隊成員",
  "邀请团队成员",
]);

export interface ChatGptIdentity {
  email?: string;
  workspaceName?: string;
}

export function isGenericWorkspaceName(name: string): boolean {
  const value = name.trim();
  if (!value || value.length > 80) return true;
  const lower = value.toLowerCase();
  if (GENERIC_WORKSPACE_NAMES.has(lower) || GENERIC_WORKSPACE_NAMES.has(value)) return true;
  if (/側邊欄|侧边栏|sidebar/i.test(value)) return true;
  if (/^(open|close|開啟|關閉|打开|关闭)\b/i.test(value)) return true;
  return false;
}

export function sanitizeChatGptWorkspaceName(name?: string): string | undefined {
  const value = name?.trim();
  if (!value || isGenericWorkspaceName(value)) return undefined;
  return value;
}

export function extractChatGptIdentity(input: {
  text?: string;
  labels?: string[];
}): ChatGptIdentity {
  const blobs = [...(input.labels ?? []), input.text ?? ""];
  const email = firstEmail(blobs);
  const workspaceName = firstWorkspaceName(input.labels ?? []);
  return {
    ...(email ? { email } : {}),
    ...(workspaceName ? { workspaceName } : {}),
  };
}

export function identityFromAuthSession(data: unknown): ChatGptIdentity {
  if (!data || typeof data !== "object") return {};
  const root = data as Record<string, unknown>;
  const user = root.user && typeof root.user === "object" ? root.user as Record<string, unknown> : {};
  const email = readString(user.email) || readString(root.email);
  if (!email || BLOCKED_EMAILS.has(email.toLowerCase())) return {};
  return { email };
}

export function identityFromAccountsCheck(data: unknown, pageText = "", accountId?: string): ChatGptIdentity {
  const accounts = accountsFromCheck(data);
  if (accounts.length === 0) return {};
  const email = accounts.map(account => account.email).find(value => value && !BLOCKED_EMAILS.has(value.toLowerCase()));
  const page = pageText.toLowerCase();
  const named = accounts
    .map(account => account.name)
    .filter((name): name is string => Boolean(sanitizeChatGptWorkspaceName(name)));
  const byId = accountId ? accounts.find(account => account.id === accountId) : undefined;
  const selected = accounts.find(account => account.selected);
  const pageMatch = named.find(name => page.includes(name.toLowerCase()));
  const workspaceName = sanitizeChatGptWorkspaceName(byId?.name)
    || sanitizeChatGptWorkspaceName(selected?.name)
    || pageMatch
    || (named.length === 1 ? named[0] : undefined);
  return {
    ...(email ? { email } : {}),
    ...(workspaceName ? { workspaceName } : {}),
  };
}

export function mergeChatGptIdentity(...parts: ChatGptIdentity[]): ChatGptIdentity {
  const email = parts.map(part => part.email).find(value => value && !BLOCKED_EMAILS.has(value.toLowerCase()));
  const workspaceName = parts
    .map(part => sanitizeChatGptWorkspaceName(part.workspaceName))
    .find((value): value is string => Boolean(value));
  return {
    ...(email ? { email } : {}),
    ...(workspaceName ? { workspaceName } : {}),
  };
}

function accountsFromCheck(data: unknown): Array<{ id?: string; email?: string; name?: string; selected?: boolean }> {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const node = root.accounts;
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([id, value]) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const account = record.account && typeof record.account === "object"
      ? record.account as Record<string, unknown>
      : record;
    const profile = record.profile && typeof record.profile === "object"
      ? record.profile as Record<string, unknown>
      : {};
    const email = readString(profile.email) || readString(record.email) || readString(account.email);
    const name = readString(account.name) || readString(record.name);
    const selected = record.is_selected === true
      || account.is_selected === true
      || record.selected === true
      || account.selected === true
      || readString(root.default_account_id) === id
      || readString(account.account_id) === id && record.is_most_recently_used === true;
    return [{
      id: readString(account.account_id) || id,
      email,
      name,
      selected,
    }];
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstEmail(blobs: string[]): string | undefined {
  const pattern = new RegExp(EMAIL_PATTERN.source, "gi");
  for (const blob of blobs) {
    const matches = blob.match(pattern) ?? [];
    for (const match of matches) {
      if (!BLOCKED_EMAILS.has(match.toLowerCase())) return match;
    }
  }
  return undefined;
}

function firstWorkspaceName(labels: string[]): string | undefined {
  const emailPattern = new RegExp(EMAIL_PATTERN.source, "i");
  for (const label of labels) {
    const lines = label.split("\n").map(line => line.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const [name, plan] = lines;
      if (name && !isGenericWorkspaceName(name) && !emailPattern.test(name)
        && (isGenericWorkspaceName(plan) || /business|plus|team|enterprise|pro|個人|个人/i.test(plan))) {
        return name;
      }
    }
  }
  for (const label of labels) {
    for (const line of label.split("\n")) {
      const name = line.trim();
      if (!name || isGenericWorkspaceName(name) || emailPattern.test(name) || /^https?:/i.test(name)) continue;
      return name;
    }
  }
  return undefined;
}

export const CHATGPT_IDENTITY_SCRIPT = `(async () => {
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
  const blocked = new Set(${JSON.stringify([...BLOCKED_EMAILS])});
  const generic = new Set(${JSON.stringify([...GENERIC_WORKSPACE_NAMES])});
  const chromeRe = /側邊欄|侧边栏|sidebar/i;
  const chromePrefixRe = /^(open|close|開啟|關閉|打开|关闭)\\b/i;
  const isGeneric = (name) => {
    const value = String(name || "").trim();
    if (!value || value.length > 80) return true;
    const lower = value.toLowerCase();
    return generic.has(lower) || generic.has(value) || chromeRe.test(value) || chromePrefixRe.test(value);
  };
  const visibleLabels = [];
  for (const root of document.querySelectorAll("nav, aside, [role='navigation']")) {
    const buttons = [...root.querySelectorAll("button")];
    for (const button of buttons.slice(-8)) {
      const text = (button.innerText || button.textContent || "").trim();
      if (text) visibleLabels.push(text);
    }
  }
  const text = [
    ...[...document.querySelectorAll("nav, aside")].map((node) => node.innerText || ""),
    document.body ? document.body.innerText.slice(0, 20000) : "",
  ].join("\\n");
  let session = null;
  try {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    if (response.ok) session = await response.json();
  } catch {}
  const token = session && typeof session.accessToken === "string" ? session.accessToken : null;
  const sessionEmail = session && session.user && typeof session.user.email === "string" ? session.user.email.trim() : null;
  let currentAccountId = null;
  try {
    for (const key of ["ChatGPT-Account-Id", "chatgpt-account-id", "accountId"]) {
      const value = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (value) {
        currentAccountId = value.replace(/"/g, "").trim();
        break;
      }
    }
  } catch {}
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (currentAccountId) headers["ChatGPT-Account-ID"] = currentAccountId;
  let api = null;
  for (const url of ["/backend-api/accounts/check/v4-2023-04-27", "/backend-api/accounts/check/v4", "/backend-api/accounts/check"]) {
    try {
      const response = await fetch(url, { credentials: "include", headers });
      if (response.ok) {
        api = await response.json();
        break;
      }
    } catch {}
  }
  const emails = [];
  if (sessionEmail && !blocked.has(sessionEmail.toLowerCase())) emails.push(sessionEmail);
  for (const blob of [...visibleLabels, text]) {
    for (const match of blob.match(emailRe) || []) {
      if (!blocked.has(match.toLowerCase())) emails.push(match);
    }
  }
  let workspaceName;
  for (const label of visibleLabels.slice().reverse()) {
    const name = label.split("\\n")[0].trim();
    if (!name || isGeneric(name) || emailRe.test(name)) continue;
    workspaceName = name;
    break;
  }
  if (api && api.accounts && typeof api.accounts === "object") {
    const parsed = [];
    for (const [id, value] of Object.entries(api.accounts)) {
      if (!value || typeof value !== "object") continue;
      const account = value.account && typeof value.account === "object" ? value.account : value;
      const profile = value.profile && typeof value.profile === "object" ? value.profile : {};
      const email = [profile.email, value.email, account.email].find((item) => typeof item === "string" && item.trim());
      const name = [account.name, value.name].find((item) => typeof item === "string" && item.trim());
      const accountId = (typeof account.account_id === "string" && account.account_id.trim()) || id;
      const selected = value.is_selected === true
        || account.is_selected === true
        || value.selected === true
        || api.default_account_id === accountId
        || (currentAccountId && currentAccountId === accountId);
      parsed.push({ id: accountId, email, name, selected });
    }
    const apiEmail = parsed.map((item) => item.email).find((item) => item && !blocked.has(String(item).toLowerCase()));
    const named = parsed.map((item) => item.name).filter((name) => name && !isGeneric(name));
    const selected = parsed.find((item) => item.selected);
    const byId = currentAccountId ? parsed.find((item) => item.id === currentAccountId) : null;
    const pageMatch = named.find((name) => text.toLowerCase().includes(String(name).toLowerCase()));
    if (apiEmail) emails.unshift(apiEmail);
    workspaceName = (byId && !isGeneric(byId.name) && byId.name)
      || (selected && !isGeneric(selected.name) && selected.name)
      || pageMatch
      || (named.length === 1 ? named[0] : workspaceName);
  }
  if (workspaceName && isGeneric(workspaceName)) workspaceName = null;
  return { email: emails[0] || null, workspaceName: workspaceName || null };
})()`;
