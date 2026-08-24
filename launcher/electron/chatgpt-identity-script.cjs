module.exports = `(async () => {
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/;
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const blocked = new Set(["support@openai.com", "noreply@openai.com", "help@openai.com", "privacy@openai.com"]);
  const generic = new Set(["chatgpt", "new chat", "temporary chat", "search", "library", "gpts", "gpt", "sora", "settings", "log out", "logout", "help", "sidebar", "side bar", "business", "plus", "team", "pro", "personal", "free", "enterprise", "側邊欄", "侧边栏", "開啟側邊欄", "开启侧边栏", "關閉側邊欄", "关闭侧边栏", "新對話", "新对话", "暫存對話", "暂存对话", "專案", "项目", "排程", "资料库", "資料庫", "外掛程式", "插件", "智慧體", "智能体", "地圖", "地图", "邀請團隊成員", "邀请团队成员"]);
  const chromeRe = /側邊欄|侧边栏|sidebar/i;
  const chromePrefixRe = /^(open|close|開啟|關閉|打开|关闭)\\b/i;
  const isGeneric = (name) => {
    const value = String(name || "").trim();
    if (!value || value.length > 80) return true;
    const lower = value.toLowerCase();
    return generic.has(lower) || generic.has(value) || chromeRe.test(value) || chromePrefixRe.test(value);
  };
  const cookie = (name) => {
    for (const part of document.cookie.split(";")) {
      const slice = part.trim();
      if (slice.startsWith(name + "=")) return decodeURIComponent(slice.slice(name.length + 1));
    }
    return "";
  };
  const pickWorkspaceFromLabel = (label) => {
    const lines = String(label || "").split("\\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2 && !isGeneric(lines[0]) && (isGeneric(lines[1]) || /business|plus|team|enterprise|pro|個人|个人/i.test(lines[1]))) {
      return lines[0];
    }
    const name = lines[0] || "";
    if (!name || isGeneric(name) || emailRe.test(name)) return "";
    return name;
  };
  const height = window.innerHeight || 800;
  const visibleLabels = [];
  for (const el of document.querySelectorAll("button, [role='button']")) {
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 20) continue;
    const text = (el.innerText || el.textContent || "").trim();
    if (!text) continue;
    if (box.left < 420 && box.bottom > height - 280) visibleLabels.push(text);
  }
  for (const root of document.querySelectorAll("nav, aside, [role='navigation']")) {
    const buttons = [...root.querySelectorAll("button")];
    for (const button of buttons.slice(-8)) {
      const text = (button.innerText || button.textContent || "").trim();
      if (text) visibleLabels.push(text);
    }
  }
  const text = [
    ...visibleLabels,
    document.body ? document.body.innerText.slice(0, 20000) : "",
  ].join("\\n");
  let session = null;
  try {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    if (response.ok) session = await response.json();
  } catch {}
  const token = session && typeof session.accessToken === "string" ? session.accessToken : null;
  const sessionEmail = session && session.user && typeof session.user.email === "string" ? session.user.email.trim() : null;
  let currentAccountId = "";
  const deviceId = cookie("oai-did") || cookie("oai-device-id");
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      if (!/account/i.test(key)) continue;
      const match = String(localStorage.getItem(key) || "").match(uuidRe);
      if (match) {
        currentAccountId = match[0];
        break;
      }
    }
  } catch {}
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (deviceId) headers["oai-device-id"] = deviceId;
  let api = null;
  const urls = ["/backend-api/accounts/check/v4-2023-04-27", "/backend-api/accounts/check/v4", "/backend-api/accounts/check", "/backend-api/me"];
  for (const withAccount of [false, true]) {
    const nextHeaders = { ...headers };
    if (withAccount && uuidRe.test(currentAccountId)) nextHeaders["ChatGPT-Account-ID"] = currentAccountId;
    else if (withAccount) continue;
    for (const url of urls) {
      try {
        const response = await fetch(url, { credentials: "include", headers: nextHeaders });
        if (response.ok) {
          const payload = await response.json();
          if (payload && (payload.accounts || payload.account || payload.email)) {
            api = payload;
            break;
          }
        }
      } catch {}
    }
    if (api) break;
  }
  const emails = [];
  if (sessionEmail && !blocked.has(sessionEmail.toLowerCase())) emails.push(sessionEmail);
  let workspaceName = "";
  for (const label of visibleLabels) {
    const name = pickWorkspaceFromLabel(label);
    if (name) {
      workspaceName = name;
      break;
    }
  }
  const accountsNode = api && api.accounts && typeof api.accounts === "object" ? api.accounts
    : api && api.account && typeof api.account === "object" ? { current: api } : null;
  if (accountsNode) {
    const parsed = [];
    for (const [id, value] of Object.entries(accountsNode)) {
      if (!value || typeof value !== "object") continue;
      const account = value.account && typeof value.account === "object" ? value.account : value;
      const profile = value.profile && typeof value.profile === "object" ? value.profile : {};
      const email = [profile.email, value.email, account.email, api.email].find((item) => typeof item === "string" && item.trim());
      const name = [account.name, account.workspace_name, value.name, account.organization_name].find((item) => typeof item === "string" && item.trim());
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
      || workspaceName
      || (named.length === 1 ? named[0] : "");
  }
  if (workspaceName && isGeneric(workspaceName)) workspaceName = "";
  return { email: emails[0] || null, workspaceName: workspaceName || null };
})()`;
