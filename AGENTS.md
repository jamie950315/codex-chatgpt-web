# Project continuity

This project runs Codex requests through an authenticated ChatGPT browser session and ships an Electron launcher. Use Bun 1.4.0 (the installed runtime includes this version); the default shell Bun may be older.

## Local and upstream scope

- `wip/webgpt-all-progress` contains local Cockpit routing in addition to the upstream-facing changes. Keep Cockpit code out of upstream PR branches.
- Upstream PRs #460–#463 respectively cover multipart/rebind, Plus/Pro context settings, Web sub-agent settings, and Traditional Chinese launcher text. Their branch names are recorded in the local `HANDOFF.md`.
- `HANDOFF.md` is local handoff material; do not commit it to upstream branches. Treat its runtime and CI claims as historical until verified.
- Source changes do not update the installed app. CI repair does not require reinstalling or restarting the user's running app.

## Verification

- `bun run verify` checks versions, audits, types, core/launcher tests, builds the runtime and renderer, and smoke-tests the runtime.
- `bun run app:package` and `bun run app:smoke` verify native packaging and actual packaged launcher startup. Build on the matching OS.
- For macOS PR reproduction, run packaging with `GITHUB_BASE_REF=main`. Certificate-free packaging explicitly uses ad-hoc signing with identity discovery disabled, including in PR builds. Credentialed builds retain electron-builder's PR protection. Do not bypass archive signature verification.
- Token counting reuses identical chunk counts only within a single call, with bounded storage. Preserve exact counting and surrogate-pair boundaries.
- Windows indexed-rollout namespace cases use separate tests and transactional database fixtures. Verify all four on Windows CI; macOS skips them.
- Check the actual upstream PR runs after pushing, not just manually dispatched fork CI. All OS checks and actionlint must pass before claiming the PR checks are fixed.

## Review hardening (local branch)

- Compaction plans full history across 3–8 parts before trimming; every message, including the final instructions and attachments, must fit. Redact retired handles before fragmentation and reject missing fragments during reconstruction validation.
- Web sub-agent filtering is namespace-aware, including current `collaboration-optimize` gateway names. Preserve unrelated services' same-named tools; direct and raw gateway calls must apply the same exclusions.
- Cockpit catalogs respect actual account capabilities and fall back to sidecar discovery when local catalog reading fails. Search and image requests resolve credentials per request. Stopping the server stops catalog reconciliation.
- Package smoke uses asynchronous child lifecycle handling and exact installed executable paths for Windows cleanup; never terminate all processes by image name.
- These review changes are local source changes until explicitly published/installed. Isolated tests do not prove real ChatGPT browser turns or Windows-native process cleanup; retain that distinction when reporting verification.

## Communication

Reply in Traditional Chinese. Keep README files in English unless requested otherwise. Do not open new upstream PRs or post comments without a request.
