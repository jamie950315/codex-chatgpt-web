const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const CHATGPT_IDENTITY_SCRIPT = require("../electron/chatgpt-identity-script.cjs");

function response(ok, payload = {}) {
  return { ok, json: async () => payload };
}

async function runIdentityScript({ bodyText = "", buttonLabels = [], session, backend } = {}) {
  const buttons = buttonLabels.map((label) => ({
    innerText: label,
    textContent: label,
    getBoundingClientRect: () => ({ width: 160, height: 40, left: 20, bottom: 780 }),
  }));
  const context = {
    document: {
      cookie: "",
      body: { innerText: bodyText },
      querySelectorAll(selector) {
        if (selector === "button, [role='button']") return buttons;
        if (selector === "nav, aside, [role='navigation']") return [];
        return [];
      },
    },
    window: { innerHeight: 800 },
    localStorage: { length: 0, key: () => null, getItem: () => null },
    fetch: async (url) => {
      if (url === "/api/auth/session") return response(session !== undefined, session);
      return response(backend !== undefined, backend);
    },
  };
  return await vm.runInNewContext(CHATGPT_IDENTITY_SCRIPT, context);
}

test("identity script never adopts an email found only in ChatGPT conversation text", async () => {
  const identity = await runIdentityScript({
    bodyText: "The user asked us to contact customer@example.com after this chat.",
  });
  assert.equal(identity.email, null);
  assert.equal(identity.workspaceName, null);
});

test("identity script rejects every consecutive email label without global-regex state leakage", async () => {
  const identity = await runIdentityScript({
    buttonLabels: ["first@example.com", "second@example.com"],
  });
  assert.equal(identity.email, null);
  assert.equal(identity.workspaceName, null);
});

test("identity script accepts authenticated session and backend account email sources", async () => {
  assert.equal(
    (await runIdentityScript({ session: { user: { email: "session-owner@example.com" } } })).email,
    "session-owner@example.com",
  );
  assert.equal(
    (await runIdentityScript({
      backend: {
        accounts: {
          current: {
            is_selected: true,
            account: { account_id: "account-current", name: "Personal" },
            profile: { email: "backend-owner@example.com" },
          },
        },
      },
    })).email,
    "backend-owner@example.com",
  );
});
