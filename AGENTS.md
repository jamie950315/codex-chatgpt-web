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
- Live browser verification on 2026-09-12: isolated latest source/backend/helper passed a short Instant response and a 210,633-estimated-token / 3-part compaction recall fixture. A 331,230-estimated-token / 4-part fixture lost the earliest marker on Medium, High, and Pro despite zero application-side trimming and all stage acknowledgements. Do not claim 400k reliable recall; the exact effective history limit is not established. No running app configuration was changed.
- `bun run scripts/smoke-live-review.ts short` or `compaction <words-per-record> <chatgpt-web/model>` performs opt-in real authenticated browser requests using a separately built helper at `launcher/build/runtime/app/browser-helper.cjs`. Synthetic requests, responses, summaries and diagnostics stay under ignored `runtime/live-review-*`; compact assertions inspect only the new summary, never echoed original inputs.
- Stronger 24-random-checkpoint text-only tests supersede the earlier three-marker confidence: Medium recall at 130,561 total estimated tokens / 122,309 visible-message tokens and compaction at 130,971 / 122,655 passed all 24. Recall at 140,553 / 132,306 lost the first whole stage; larger examples retain contiguous later stages. This supports, but does not prove, approximately 128k accumulated visible context. Do not treat message acceptance as recall or infer a safe 200k window from the older fixture. Rate-limited attempts are not length failures.
- Live harness supports `recall|compaction <tokens-per-record> <model> words|code|chinese [auto|medium|max]`; non-auto staging builds a clearly separate experimental helper and does not change production code. `run-live-context-confirmation.ts` is serial, paced, and stops on rate limits. Code/Chinese live coverage and repeated near-boundary confirmation remain pending after rate limits; fixture generation alone is not live verification.

## Communication

Reply in Traditional Chinese. Keep README files in English unless requested otherwise. Do not open new upstream PRs or post comments without a request.
