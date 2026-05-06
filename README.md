# Self-Healing Browser Tests with E2B + Vercel AI SDK

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?logo=buymeacoffee)](https://buymeacoffee.com/qualitymax)

Generate Playwright tests from natural-language specs, run them inside isolated [E2B](https://e2b.dev) sandboxes, and have the LLM heal them automatically when they fail. Multi-model fallback (Claude → GPT → Gemini) so a single-provider outage doesn't take the suite down.

This is a QualityMax-contributed demo of what falls out when you combine E2B sandboxes, the Vercel AI SDK, and a fail → snapshot → retry loop. The pattern is inspired by the self-healing behaviour used in production at [qualitymax.io](https://qualitymax.io), but the code here is standalone TypeScript — it shares the *concept*, not the implementation.

> **Scope note:** this cookbook demonstrates the self-healing *loop*, not a full test-generation pipeline. Test generation is a single zero-shot prompt — no DOM pre-inspection, no few-shot examples, no structured output. The whole point is that healing makes even the crude version workable.

> **Status:** spike-quality reference example. The code is structured for clarity and copy-pasting; production deployments will want a custom E2B template with Playwright pre-baked, retry/backoff on transient errors, and a real telemetry sink.

---

## Why

Browser tests break the moment a button moves or a class name changes. Two common workarounds:

1. **Brittle CSS selectors + a human on call** — the status quo at most teams.
2. **Self-healing tests** — capture the page state at failure, hand it to an LLM with the original spec, get back a fixed test.

(2) only works if you can run the regenerated test in a clean, isolated environment without contaminating CI. That's exactly what E2B sandboxes give you: 200 ms cold-start Firecracker microVMs, throwaway state, no risk to your real infrastructure.

This repo wires the two together.

---

## Architecture

```
  TestSpec (NL description + URL)
        │
        ▼
  ┌──────────────┐  fallback chain (Claude → GPT → Gemini)
  │   router.ts  │  via Vercel AI SDK
  └──────┬───────┘
         │ generated Playwright TS
         ▼
  ┌──────────────┐  fresh sandbox per attempt
  │   runner.ts  │  runs test in E2B playwright-chromium sandbox
  └──────┬───────┘
         │ pass / fail + stdout / stderr / page snapshot
         ▼
  ┌──────────────┐  on fail: rewrite prompt with snapshot + errors
  │   healer.ts  │  back through router → runner, up to N attempts
  └──────────────┘
```

Three small modules, ~250 lines total:

- **[`src/router.ts`](src/router.ts)** — multi-model router. Reads `ROUTER_ORDER` from env, drops providers without keys, falls back on any error.
- **[`src/runner.ts`](src/runner.ts)** — E2B execution. Spins up `Sandbox.create()`, writes the generated test, installs Playwright + Chromium, executes, captures result.
- **[`src/healer.ts`](src/healer.ts)** — failure → snapshot → prompt → retry loop.

---

## Quick start

```bash
git clone https://github.com/Quality-Max/e2b-cookbook-self-healing-tests
cd e2b-cookbook-self-healing-tests
pnpm install            # or npm install
cp .env.example .env    # then fill in keys
pnpm typecheck          # sanity check
pnpm example:basic      # run the simplest example
```

You need:

- **An [E2B](https://e2b.dev) API key** (free tier is enough for these examples).
- **At least one** of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. The router silently drops providers without keys, so a partial setup still works.

Sandbox cold start on the `playwright-chromium` template is fast (~200 ms) — Chromium + browser deps come pre-baked. The only per-run install cost is `@playwright/test` (~5–10 s). Per attempt: **~30–80 s** wall clock, mostly LLM latency + test run. This is a rough estimate anchored on one measured 3-attempt healing run at ~50 s/attempt; real variance comes from sandbox cold-start jitter, network to the target site, and model response time. Full healing demo (2–3 attempts): **~2–4 min** total.

For CI use where you want the `@playwright/test` install cost gone too, build your own E2B template with it pre-baked on top of `playwright-chromium` — drops each attempt back toward the 200 ms floor.

---

## Examples

| Script | What it shows |
| --- | --- |
| [`examples/01-basic-test.ts`](examples/01-basic-test.ts) | Simplest path: spec → generated test → one sandboxed run, no healing. |
| [`examples/02-self-healing.ts`](examples/02-self-healing.ts) | The headline. A vague spec produces a brittle test, the failure snapshot is fed back to the LLM, the retry passes. |
| [`examples/03-multi-model-fallback.ts`](examples/03-multi-model-fallback.ts) | Simulate a provider outage by poisoning the Anthropic key. The router falls back to OpenAI / Google. The test still ships. |
| [`examples/04-parallel-suite.ts`](examples/04-parallel-suite.ts) | Run multiple healing tests concurrently in isolated sandboxes. |

Run any of them with `pnpm example:<name>` (see `package.json`).

---

## How healing actually works

The non-obvious bit is what we feed back to the LLM after a failure. From [`src/healer.ts`](src/healer.ts):

1. **System rules** tell the LLM to dump `await page.content()` to `/home/user/failure.html` before throwing on any test failure. Without this, healing degrades to guessing from `stderr` alone.
2. **The runner** reads that snapshot off the sandbox filesystem after the failed run.
3. **The heal prompt** includes the previous code, the truncated stdout/stderr, and the page snapshot, with an explicit instruction to prefer role / accessible-name / data-testid selectors over brittle CSS paths.
4. **Each retry** spins up a fresh sandbox, so failures don't compound.

`HEAL_MAX_ATTEMPTS` caps the loop (default `3`).

### What a real run looks like

Verified end-to-end trace from a fresh E2B account, vague spec ("click whatever leads to docs, verify 'sandbox' appears"):

```
$ npm run example:healing

→ attempt 1: LLM writes getByRole('link', { name: /Docs|Documentation/i })
  ✘ strict mode violation: locator resolved to 4 elements
  → healer reads /home/user/failure.html, feeds DOM back to the LLM
→ attempt 2: LLM rewrites with a specific data-testid / nth() selector
  ✓ test passes

Final: ✓ passed
Attempts: 2
  attempt 1 -- fail (generated by google)
  attempt 2 -- pass (generated by google)
```

Each attempt spins up a fresh sandbox — failures from attempt 1 can't contaminate attempt 2.

---

## Why multi-model fallback matters

LLM provider availability is not 100 %. On **15 April 2026** an Anthropic incident took down Claude API access for several hours. Single-provider agents went dark. Anything with a router survived.

[`examples/03-multi-model-fallback.ts`](examples/03-multi-model-fallback.ts) reproduces the failure mode locally by poisoning the Anthropic key. **You need at least two provider keys configured for this demo to show anything meaningful** — with only one key the router has nowhere to fall back to. The router catches the auth error and moves on:

```
→ Anthropic key is poisoned. Router should fall back.
✓ test generated -- the router landed on openai
✓ test passed
```

Production code will want to:

- Distinguish transient (5xx, rate limit) from permanent (auth) errors and retry transients on the same provider before falling back.
- Track provider-level success rates and reorder dynamically.
- Cap total wall-clock so a slow fallback doesn't block the loop.

The pattern in this repo is the floor, not the ceiling.

---

## Adapting it

**Use a different test framework.** Replace the install step in [`src/runner.ts`](src/runner.ts) and the `SYSTEM_RULES` in [`src/healer.ts`](src/healer.ts). Cypress, Vitest browser mode, Pytest + Selenium — anything that runs in a Linux sandbox works.

**Add more providers.** [`src/router.ts`](src/router.ts) maps provider names to AI SDK clients. Add a case to `modelFor()` and an entry to `ENV_KEY_BY_PROVIDER`.

**Build a custom E2B template.** The Chromium install is the slow step. Pre-bake it once and you're back to ~200 ms cold start.

**Wire it into CI.** The whole entry point is `runHealingTest(spec, maxAttempts)`. Call it from a GitHub Action and post the trace to your build summary.

---

## Troubleshooting

If you see any of these, you're probably on a commit before recent fixes ([#1](https://github.com/Quality-Max/e2b-cookbook-self-healing-tests/pull/1), [#4](https://github.com/Quality-Max/e2b-cookbook-self-healing-tests/pull/4)) — pull `main`.

- **`Error: No tests found`, test file starts with ``` ```typescript ```** — LLM wrapped its output in markdown fences despite the prompt saying not to (Gemini does this occasionally). `router.ts` strips outer fences before returning.
- **`error while loading shared libraries: libnspr4.so`** — E2B's default `base` template lacks Chromium's system libraries. The cookbook now uses E2B's pre-baked `playwright-chromium` template via `Sandbox.create('playwright-chromium')`, which ships Chromium + browser deps ready to use (see [#4](https://github.com/Quality-Max/e2b-cookbook-self-healing-tests/pull/4)).
- **`CommandExitError: exit status 1` propagating past `runHealingTest`** — the E2B SDK throws on non-zero exit rather than returning a result. `runner.ts` catches the typed `CommandExitError` so a failing test becomes a `RunResult` the healer can read, instead of unwinding the stack.

If the router keeps landing on the same provider, check that the others' keys are both *set* and *valid* — the router silently drops providers with missing keys and silently moves past providers that throw (including on auth errors). Dump `failures` from `AllProvidersFailedError` if all of them fail in a row.

---

## Credits

- Self-healing pattern inspired by [qualitymax.io](https://qualitymax.io).
- Sandbox runtime: [E2B](https://e2b.dev).
- Model orchestration: [Vercel AI SDK](https://sdk.vercel.ai).

## License

[Apache-2.0](LICENSE).
