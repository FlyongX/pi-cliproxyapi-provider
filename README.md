# pi-cliproxyapi-provider

Pi provider extension that discovers models from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and registers them for use in pi. It supports catalog-driven OpenAI Fast mode and also ships a small TUI helper that shows elapsed runtime and a TPS summary after each agent turn.

## What it does

1. Registers a provider that always appears in `/login` (account sign-in path).
2. Interactive setup collects `baseUrl` + `apiKey` via `/login CLIProxyAPI` or `/login cliproxyapi`.
3. Fetches `{root}/v1/models?client_version=pi`.
4. Maps the CLIProxyAPI catalog into pi models, including Fast service-tier capability.
5. Registers inference against `{root}/backend-api/`.
6. Provides `/fast` to toggle OpenAI priority processing for supported models.
7. Caches the model catalog in `~/.pi/agent/cliproxyapi-models.json`, refreshes it in the background on startup with missing-model grace, and provides `/cliproxyapi-refresh` for strict catalog synchronization.
8. In interactive TUI sessions, shows footer elapsed time during runs and a TPS / token usage toast when the agent settles.
9. After compaction, closes the reused Codex WebSocket for that session so CLIProxyAPI's server-side context resets with the compacted client messages.

## Install

```bash
# from npm
pi install npm:@router-for-me/pi-cliproxyapi-provider

# from a local checkout
pi install /absolute/path/to/pi-cliproxyapi-provider

# or temporarily for one run
pi -e /absolute/path/to/pi-cliproxyapi-provider
```

## Login-style setup (recommended)

This plugin needs both **baseUrl** and **apiKey**. pi's built-in `/login` only supports multi-field prompts on the account/OAuth path, so CLIProxyAPI appears under **Sign in with an account** (not API key).

### Preferred: /login shortcuts

```text
/login CLIProxyAPI
```

or:

```text
/login cliproxyapi
```

These shortcuts jump straight into CLIProxyAPI's multi-field baseUrl + API key prompts. The provider is registered as OAuth-only, so pi does not ask you to choose between API key and account first.

### Menu path

```text
/login
```

Then choose:

1. **Sign in with an account**
   (required for multi-field baseUrl + API key prompts)
2. **CLIProxyAPI**
3. Enter:
   - base URL — preferred form is host:port, e.g. `http://127.0.0.1:8317`
   - API key

Final login validation calls `{root}/v1/models?client_version=pi` (this always bypasses the model cache and forces a fresh remote query):

- **HTTP 200** → login succeeds (empty model list is still OK) and the model cache is rewritten
- **non-200 / network error** → login fails and you are prompted to re-enter base URL + API key

On success:

- models are registered immediately in the current session (0 models is allowed)
- `baseUrl` / `apiKey` are written to `~/.pi/agent/cliproxyapi.json`
- pi also stores the returned credential in `~/.pi/agent/auth.json`

Re-run `/login CLIProxyAPI` or `/login cliproxyapi` anytime to reconfigure. The built-in `/logout` command only removes credentials saved in `auth.json`; it does not erase `cliproxyapi.json`. Remove or update that file if you also need to clear the provider configuration.

## Non-interactive configuration

You can still configure without `/login`.

### Config file

`~/.pi/agent/cliproxyapi.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "fast": false,
  "pause": false
}
```

Optional fields:

| Field | Default | Description |
| ------- | --------- | ------------- |
| `baseUrl` | `http://127.0.0.1:8317` | CLIProxyAPI address |
| `apiKey` | _(required unless set via /login or env)_ | Bearer token / CPA API key |
| `providerId` | `cliproxyapi` | Provider id shown in `/model` |
| `providerName` | `CLIProxyAPI` | Display name in `/login` and UI |
| `fast` | `false` | Persisted Fast mode preference; only applies to catalog-supported models |
| `pause` | `false` | Persisted request-pause preference; provider requests wait until it is cleared |

### Environment overrides

| Variable | Overrides |
| ---------- | ----------- |
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |
| `CLIPROXYAPI_FAST` | `fast` (`true` / `false`, also accepts `1`, `0`, `yes`, `no`, `on`, `off`) |

Resolution order for connection settings:

1. Environment variables
2. `cliproxyapi.json`
3. `/login` credentials in `auth.json`
4. Default baseUrl `http://127.0.0.1:8317`

The Fast preference resolves separately as `CLIPROXYAPI_FAST` → `cliproxyapi.json` → `false`.

### baseUrl normalization

Preferred form is **host:port only**:

| Input | Inference baseUrl | Models URL |
| ------- | ------------------- | ------------ |
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | `http://127.0.0.1:8317/v1/models?client_version=pi` |
| `http://127.0.0.1:8317/backend-api` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | same models URL |

pi then sends inference traffic to `{inference}/codex/responses`.

## Fast mode

OpenAI Fast mode requests the priority service tier. It can reduce latency for supported models, but consumes more OpenAI/Codex credits or incurs priority-processing pricing.

Fast is **off by default**. Toggle the global preference with:

```text
/fast
```

Each invocation switches Fast between on and off and writes the result to `~/.pi/agent/cliproxyapi.json`. On the next startup, a persisted `true` value immediately enables Fast for catalog-supported models. Fast remains ineffective for unsupported models, so their requests are left unchanged. If `CLIPROXYAPI_FAST` is set, that environment variable still takes precedence on startup.

When Fast is effective, pi's model status appends a yellow lowercase `fast`, for example `gpt-5.6-sol • xhigh • fast`. When Fast is off or the selected model is unsupported, the original model status remains unchanged. Supported models do not produce a separate status notification. Running `/fast` with an unsupported model still updates the global preference; enabling it warns that the current model cannot use Fast.

Fast capability is catalog-driven: the plugin considers a CLIProxyAPI model Fast-capable when its `service_tiers` field is a non-empty array. The `additional_speed_tiers` field is ignored. For supported models, Fast injects `service_tier: "priority"`; unsupported models are left unchanged. Fast is independent from pi's reasoning/thinking level. When `models.dev` provides `experimental.modes.fast.cost`, the registered model cost switches to those Fast rates as well; the provider is refreshed when `/fast` is toggled. If no Fast price is published, the standard price is retained. The plugin does not guess Fast prices from `-pro`/`-fast` model IDs.

## Pausing provider requests

Pause provider requests with:

```text
/pause
```

Use `/continue` to clear the pause:

```text
/continue
```

Both commands persist the `pause` boolean in `~/.pi/agent/cliproxyapi.json`. Before every provider request, the extension rereads this setting. When it is `true`, the request waits asynchronously and checks again every 200 ms until `/continue` sets it to `false`. A pause issued during an active run lets that run finish before Elapsed stops; a run that starts while paused excludes its waiting time from Elapsed and TPS.

## Model cache

The provider keeps a separate cache file so startup stays fast when CLIProxyAPI is slow or briefly unreachable:

`~/.pi/agent/cliproxyapi-models.json`

The cache stores only model metadata and derived endpoint URLs — the model list, Fast-capable IDs, `inferenceBaseUrl`, `modelsUrl`, and a `fetchedAt` timestamp. It **never** stores your API key or other credentials.

| Property | Value |
|----------|-------|
| Cache file | `~/.pi/agent/cliproxyapi-models.json` |
| Remote query timeout | 60 seconds |
| Scope | tied to the current `baseUrl` (a different base URL ignores the existing cache) |

### Startup / resume behavior

When the provider loads (including session resume):

1. If a cache exists for the configured `baseUrl`, its models are registered immediately. A remote query to `{root}/v1/models?client_version=pi` then runs in the background; on success, the cache is rewritten and the registered model list is refreshed. If the query fails, the existing cache remains active.
2. If no matching cache exists, the remote query runs synchronously. On success, the cache is written and the fetched models are registered. If it fails, startup logs a warning and no models are registered until the proxy responds.

Startup, background refreshes, login, and other non-manual refreshes retain missing cached models as `stale` for a seven-day grace window starting when they first disappear. This tolerates temporary upstream capacity pruning; reappearing models become fresh again. Existing stale-model recovery retries remain in place. Forcing a remote query alone does not disable this grace window.

### Refresh commands

- `/cliproxyapi-refresh` — fetch and **strictly synchronize** the current CPA catalog, rewrite the CPA mapping cache, and update registered models and Fast-capable IDs. Added and reappearing models are registered; missing models and entries with `visibility: "hide"` are removed immediately, without grace. It also **forces a models.dev refresh**, bypassing its 24-hour cache validity. Use this after proxy catalog or reference metadata changes, without restarting pi.
- `/login CLIProxyAPI` / `/login cliproxyapi` — re-entering credentials always forces a fresh CPA models query and rewrites its cache, but keeps the existing permissive login validation and missing-model grace. It still respects the models.dev cache's 24-hour validity, as do startup, background CPA refreshes, recovery and Fast toggles.

Manual strict synchronization requires successful HTTP and a valid JSON catalog: a model array, `{ "models": [...] }`, or `{ "data": [...] }`, with a non-empty `slug` or `id` for each entry. An explicit empty array (or a catalog containing only hidden models) is a successful **zero-model** result: registration and the CPA mapping cache are cleared, including Fast IDs. The provider remains available for configuration and later refreshes; historical or built-in lists are not restored as a fallback.

Network/HTTP errors, cancellation/timeouts, non-JSON bodies, and unknown or malformed catalog structures are **failures**, not empty catalogs. The manual command reports an error and leaves the previous CPA registration and mapping cache unchanged. Older or cancelled refresh results cannot overwrite a newer catalog.

There is no periodic full-catalog polling or automatic synchronization of subsequent proxy changes. Use the existing manual command for deterministic synchronization; startup refresh and stale-model recovery are not a replacement for it. A published model is not a guarantee that every inference request will succeed. Removing the currently selected model does not automatically switch models, interrupt an in-flight request, or delete session history; selection is left to you and pi.

Delete `~/.pi/agent/cliproxyapi-models.json` to clear the cache manually.

## Model mapping

From CPA catalog entry → pi model:

| CPA field | Pi field |
| ----------- | ---------- |
| `slug` | `id` |
| `display_name` | `name` |
| `context_window`, then `max_context_window` | `contextWindow` fallback when reference metadata is unavailable |
| `input_modalities` | `input` (`text` / `image`) |
| `max_tokens`, then `max_output_tokens`, then `max_completion_tokens` | `maxTokens` fallback when reference metadata is unavailable |
| `supported_reasoning_levels[].effort` | `thinkingLevelMap` + `reasoning` fallback when reference metadata cannot correct them |
| `visibility: "hide"` | skipped |

### Limits and reasoning metadata

For each limit independently, the priority is:

1. Your pi `models.json` **modelOverrides** (the host's final override layer).
2. A reliably matched models.dev field: `limit.context` → `contextWindow`, `limit.output` → `maxTokens`.
3. The valid CPA fields listed above, in their existing fallback order.
4. Defaults: 128000 context tokens and 16384 output tokens.

Only finite positive numbers are accepted. A missing or invalid reference field falls back independently; a valid reference field can replace an inaccurate CPA value, even if it is larger. The plugin does not take the minimum of both sources. Metadata can come from reference entries without prices.

Matching prefers original providers (for example OpenAI, Anthropic, Google, DeepSeek and Alibaba/Qwen), using full IDs, explicit provider namespaces and unambiguous separator normalization. It does not strip variant suffixes or use pricing aliases to infer capabilities. Conflicting reseller limits or reasoning information remain unmatched, even if their prices are equal; unmatched CPA models remain available with their CPA/default metadata.

When `reasoning_options` contains valid named `effort.values`, those declarations replace CPA thinking levels. Unsupported pi levels are set to `null`. Only an explicit `none` enables `off` → `none`; toggle, `null` and `default` do not imply it. `max`, `xhigh` and `ultra` are not aliased to each other, and a level the host cannot express is not made selectable. Explicit `reasoning: false` disables reasoning and clears CPA effort mappings. Budget-token or toggle-only controls, absent named efforts and malformed reasoning information leave CPA reasoning unchanged; they do not prevent independent limit corrections. No new budget/toggle protocol adapter is added.

These are **reference model limits, not a guarantee that your proxy accepts requests of that size**. If CPA enforces smaller limits, use pi's existing escape hatch in `~/.pi/agent/models.json` (substitute your configured provider/model IDs):

```json
{
  "providers": {
    "cliproxyapi": {
      "modelOverrides": {
        "gpt-5.4": {
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      }
    }
  }
}
```

The plugin does not change the currently selected thinking level or add notifications/clamping when supported efforts change. The user and pi handle the selection. Input modalities, Fast capability, endpoints and non-manual missing-model grace are unchanged.

### Prices and shared reference cache

When available, prices are matched against canonical model entries in `models.dev`; `cost.tiers[].tier.size` becomes pi's `inputTokensAbove`, including thresholds such as `272000`. The legacy `context_over_200k` field is used only when no explicit tiers are present. Ambiguous reseller prices are not selected arbitrarily and fall back to zero. These are catalog/list prices, not a guarantee of CPA's own markup or billing.

A small **pricing-only** alias table covers known CLIProxyAPI variants such as `gemini-pro-agent` → `gemini-3.1-pro-preview`; it is never reused for metadata, and unknown variants are not guessed.

Prices and metadata reuse the same raw `models.dev` response; no second directory is downloaded. It is cached at `<agentDir>/cache/cliproxyapi/models-dev.json`, where `agentDir` is resolved by the pi host (normally `~/.pi/agent`, or the directory selected by `PI_CODING_AGENT_DIR`). Different agent directories have isolated caches; sessions using the same agent directory reuse its cache. The file preserves the original `{ "timestamp": ..., "providers": ... }` format, including the full providers data, and contains no CPA credentials.

The cache remains valid for 24 hours. A fresh cache avoids the network request except for `/cliproxyapi-refresh`. An expired or manually forced cache is refreshed with the existing three-second timeout. Network, HTTP, or JSON failures retain usable old data, even when it was still fresh. Without usable cached data, prices fall back to zero and metadata falls back to CPA/default values, without blocking CPA discovery, refresh or login. Cache write failures are also tolerated.

The old `<agentDir>/tmp/models-dev-cache.json` location is **not automatically read, copied, migrated, or deleted**. If the new location has no cache, the normal cache-miss flow runs. You may manually copy an existing cache in the same format to the new location. Standalone helper calls without an `agentDir` still use the existing system temporary file, `pi-cliproxyapi-models-dev-cache.json`; extension calls do not fall back to that shared file.

To clear the raw models.dev cache, delete `<agentDir>/cache/cliproxyapi/models-dev.json` (normally `~/.pi/agent/cache/cliproxyapi/models-dev.json`). The next models.dev lookup fetches it again. This does not move or clear `cliproxyapi.json`, `auth.json`, or the separate CPA mapped-model cache, `cliproxyapi-models.json`.

## Migration from static models.json

If you previously maintained a static provider such as `cpa-responses` in `~/.pi/agent/models.json`:

1. Install this package and run `/login CLIProxyAPI` or `/login cliproxyapi` (or set `cliproxyapi.json`).
2. Point `defaultProvider` / `enabledModels` at `cliproxyapi/<model-id>` (or set `providerId` to `cpa-responses` for a drop-in id).
3. Remove the hand-maintained models array once the dynamic list looks correct.

## Elapsed time and TPS (TUI)

The package also registers `extensions/tps.ts`, which only activates for the primary interactive TUI session (`ctx.hasUI && ctx.mode === "tui"`):

- While the agent is running, the footer shows `Elapsed …` (updates every second).
- When the agent settles, the footer keeps the final elapsed time and a notification reports approximate TPS plus token usage (`out` / `in` / cache r/w / total).
- Subagent and print-mode sessions do not own the timer, clear the parent footer, or emit TPS toasts.

Disable just this helper via `pi config` if you only want the CLIProxyAPI provider.

## Failure behavior

- CLIProxyAPI `closed network connection` responses are normalized as transient network errors so pi's agent-level retry policy reconnects and restarts the interrupted assistant turn. Completed conversation and tool results remain available; token streaming does not resume from the exact interruption point.
- Before setup / without credentials: provider still appears in `/login`; no models are listed yet.
- After successful `/login`: models are registered; credentials are stored in `auth.json` and mirrored to `cliproxyapi.json`.
- The built-in `/logout` command removes only the matching `auth.json` credential; environment variables and `cliproxyapi.json` are unchanged.
- If a models request returns **HTTP 401** or CPA is unreachable during startup, an existing matching cache remains in use while the background refresh fails. Only when no cache is available is a warning logged; reconfigure via `/login CLIProxyAPI` or fix config/env.
- Login final step validates credentials by requesting models:
  - HTTP 200 (including empty catalog) → credentials are persisted
  - non-200 / network / invalid baseUrl → nothing is persisted; re-enter baseUrl + API key
- If CPA returns HTTP 200 with zero usable models: login still succeeds; re-run `/login CLIProxyAPI` later after models become available.
- If the selected model does not provide a non-empty `service_tiers` array: the request is left unchanged; `/fast` still updates the global preference and warns when enabling it.
- After `/compact`, threshold compaction, or overflow recovery, the provider closes the reused Codex WebSocket for the current session. CLIProxyAPI binds server-side context to the connection, so a reused socket would keep reporting a near-full `cacheRead` and retrigger proactive compaction even though the client context is now small. SSE is unaffected because it bills from the request body.
