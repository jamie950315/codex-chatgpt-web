import { expect, test } from "bun:test";
import {
  extractChatGptIdentity,
  identityFromAccountsCheck,
  identityFromAuthSession,
  sanitizeChatGptWorkspaceName,
} from "../src/chatgpt-identity";

test("extracts a ChatGPT account email and ignores OpenAI support addresses", () => {
  expect(extractChatGptIdentity({
    text: "support@openai.com  Settings  jamie@0ruka.dev  Log out",
  })).toEqual({ email: "jamie@0ruka.dev" });
});

test("reads the workspace switcher title above the plan label", () => {
  expect(extractChatGptIdentity({
    labels: ["開啟側邊欄", "邀請團隊成員", "US Workspace\nBusiness"],
  })).toEqual({ workspaceName: "US Workspace" });
});

test("ignores ChatGPT chrome labels such as the sidebar toggle", () => {
  expect(extractChatGptIdentity({
    labels: ["側邊欄", "ChatGPT", "US Workspace"],
  })).toEqual({ workspaceName: "US Workspace" });
  expect(extractChatGptIdentity({
    labels: ["開啟側邊欄", "New chat"],
  })).toEqual({});
  expect(sanitizeChatGptWorkspaceName("開啟側邊欄")).toBeUndefined();
});

test("reads the ChatGPT session email", () => {
  expect(identityFromAuthSession({
    user: { email: "jamie950315@icloud.com", name: "Jamie" },
    accessToken: "token",
  })).toEqual({ email: "jamie950315@icloud.com" });
});

test("extracts a workspace switcher label that is not a generic ChatGPT control", () => {
  expect(extractChatGptIdentity({
    labels: ["ChatGPT", "New chat", "0ruka UK", "jamie950315@icloud.com"],
  })).toEqual({
    email: "jamie950315@icloud.com",
    workspaceName: "0ruka UK",
  });
});

test("reads email and the selected workspace from ChatGPT accounts check", () => {
  expect(identityFromAccountsCheck({
    accounts: {
      personal: {
        account: { name: "Personal" },
        profile: { email: "jamie950315@icloud.com" },
      },
      team: {
        account: { name: "0ruka UK" },
        profile: { email: "jamie950315@icloud.com" },
        is_selected: true,
      },
    },
  })).toEqual({
    email: "jamie950315@icloud.com",
    workspaceName: "0ruka UK",
  });
});

test("matches the on-page workspace when accounts check has several names", () => {
  expect(identityFromAccountsCheck({
    accounts: {
      uk: { account: { name: "0ruka UK" }, profile: { email: "jamie@0ruka.dev" } },
      us: { account: { name: "0ruka US" }, profile: { email: "jamie@0ruka.dev" } },
    },
  }, "Library\n0ruka US\nNew chat")).toEqual({
    email: "jamie@0ruka.dev",
    workspaceName: "0ruka US",
  });
});
