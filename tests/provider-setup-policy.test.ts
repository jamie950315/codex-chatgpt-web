import { expect, test } from "bun:test";
import { providerModeRouteConflict } from "../src/setup";

test("Provider setup refuses an actively managed Codex route", () => {
  expect(providerModeRouteConflict({ installed: true, active: true, errors: [] })).toBe(true);
});

test("Provider setup permits an external route that no longer matches the managed journal", () => {
  expect(providerModeRouteConflict({
    installed: true,
    active: true,
    errors: ["Codex openai_base_url changed after setup; refusing to overwrite the user's newer value"],
  })).toBe(false);
});

test("Provider setup fails closed for an active journal with unrelated corruption", () => {
  expect(providerModeRouteConflict({
    installed: true,
    active: true,
    errors: ["Managed Codex route marker changed after setup; refusing to overwrite it"],
  })).toBe(true);
});

test("Provider setup permits an explicitly disconnected managed route", () => {
  expect(providerModeRouteConflict({ installed: true, active: false, errors: [] })).toBe(false);
});
