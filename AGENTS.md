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
- Distributed-checkpoint tests do not establish a fixed safe window. Earlier 24-marker runs passed around 131k total and lost old stages around 141k, but the matched staging experiment below recovered markers spanning about 243k of later messages. A universal 128k cap is therefore not established; do not infer safe 200k–400k recall from sparse markers or message acceptance. Rate-limited attempts are not length failures.
- Live harness supports `recall|compaction <tokens-per-record> <model> words|code|chinese [auto|medium|max]`; non-auto staging builds a clearly separate experimental helper and does not change production code. `run-live-context-confirmation.ts` is serial, paced, and stops on rate limits. Code/Chinese live coverage and repeated near-boundary confirmation remain pending after rate limits; fixture generation alone is not live verification.
- `run-live-staging-comparison.ts` uses one saved, validated fixture (`CGW_LIVE_FIXTURE`) and serial fresh conversations to compare Medium→Medium/High/Pro against Instant→Medium. All four matched 331,691–331,692-total-token runs returned 18/24 checkpoints, losing the same first part; all stages were acknowledged, actual selected efforts checked, and app trimming was zero. Medium staging did not resolve this failure. Fixture, logs and results are in ignored `runtime/staging-comparison-*`. Installed runtime and upstream branches remain unchanged.
- Passive network tracing (`CGW_LIVE_NETWORK_TRACE=1`, isolated helper only) confirmed all four browser requests exactly matched their prepared text, contained all 24 checkpoints across the requests, shared one conversation, and each parent referenced the preceding assistant response. Request/response metadata reported `gpt-5-6-thinking`; recall still lost part 1. This locates the failure after client transmission, not an omitted part or wrong parent. Server-side history pruning remains a hypothesis, not a confirmed internal rule. Context windows cannot be multiplied by part count to establish reliable recall.
- `run-live-chunked-recall.ts` explores bounded extraction without a production change. The first three ~89k-total independent reads each recovered 6/6; the fourth hit a rate limit, so the final synthesis was not run. Actual baseline output (18) plus rereading the missing first block (6) covers all 24 test tokens; that is recovery evidence, not proof of a finished general-purpose workflow. Preserve original data outside model history and read it on demand rather than advertise unverified flat 400k input.
- A later traced short Pro request reported `gpt-6-pro` / `thinking_effort=standard` in both request and response, confirming that UI Pro is not simply Medium. Regular-chat experimental probes (`CGW_LIVE_CHAT_MODE=regular`) found a different model selector (Astra/Sol/Terra/Luna/GPT-5.5), but stopped before submitting text; no regular-chat large-context result exists. This flag is an incomplete isolated research path, not supported production mode.
- Local Codex `debug models --bundled` reported default 272k / maximum 872k for native `gpt-5.6-sol` and `gpt-6-astra`. This is a candidate separate native route, not proof of backend acceptance and not WebGPT capacity. Native large-window inference was not attempted; it consumes Codex allowance. Do not enable paid API usage or claim 300k–400k delivery without separately verifying the chosen route and full raw input.

## Communication

Reply in Traditional Chinese. Keep README files in English unless requested otherwise. Do not open new upstream PRs or post comments without a request.
