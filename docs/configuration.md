---
title: Configuration
nav_order: 10
---

# Config

- Router config file: `~/.modelrelay.json`
- Environment variable overrides:
  - `NVIDIA_API_KEY`
  - `GROQ_API_KEY`
  - `CEREBRAS_API_KEY`
  - `SAMBANOVA_API_KEY`
  - `OPENROUTER_API_KEY`
  - `OPENCODE_API_KEY`
  - `OLLAMA_API_KEY`
  - `OLLAMA_BASE_URL`
  - `OLLAMA_MODEL`
  - `CODESTRAL_API_KEY`
  - `HYPERBOLIC_API_KEY`
  - `SCALEWAY_API_KEY`
  - `KIRO_REFRESH_TOKEN`
  - `KIRO_OAUTH_CLIENT_ID` (optional, for AWS Builder/IDC refresh flow)
  - `KIRO_OAUTH_CLIENT_SECRET` (optional, for AWS Builder/IDC refresh flow)
  - `GOOGLE_API_KEY`

- Security and server settings (see [Security](security.md)):
  - `MODELRELAY_ADMIN_TOKEN` (require sign-in for the admin API and dashboard)
  - `MODELRELAY_ALLOWED_HOSTS` (extra host names the admin API answers to; `*` disables the check)
  - `MODELRELAY_ALLOWED_ORIGINS` (extra browser origins, for reverse proxies that rewrite `Host`)
  - `MODELRELAY_HOST` (interface to listen on; same as `--host`)
  - `MODELRELAY_API_JSON_LIMIT` (admin API request body limit, default `1mb`)
  - `MODELRELAY_JSON_LIMIT` (`/v1` proxy request body limit, default `10mb`)
  - `MODELRELAY_OPENCODE_FREE_COMPAT` (`1` enables the OpenCode Zen free-tier compatibility mode, see below)
  - `MODELRELAY_OPENCODE_FREE_TIER_USER_AGENT` (overrides the User-Agent sent in that mode)

Kiro OAuth notes:
- Base endpoint is preconfigured to `https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse`
- Current Kiro model IDs include `claude-sonnet-4.5` and `claude-haiku-4.5`
- Authentication uses OAuth access tokens refreshed from:
  - `KIRO_REFRESH_TOKEN`, or
  - `~/.aws/sso/cache` (auto-detected refresh token), following OmniRoute’s approach.

## OpenCode Zen free-tier compatibility

OpenCode's free models only answer requests that carry the request shape of the official OpenCode
client. **This fork imitates that client by default**, so the free models are routed to out of the
box. The reasoning and the measured gate conditions are in
[Free tier notes](free-tiers.md).

To turn the mode off, set `opencodeFreeTierCompat` in `~/.modelrelay.json`:

```jsonc
{
  "opencodeFreeTierCompat": false
}
```

Or set the environment variable, which takes precedence over the config file:

```bash
export MODELRELAY_OPENCODE_FREE_COMPAT=0
```

Only `1`, `true`, `yes` and `on` enable it, and only `0`, `false`, `no` and `off` turn it off. An
unset value means the default of this fork, which is on.

The mode sends a User-Agent of `opencode/1.19.3`. To use a different one — for example when that
version goes stale — set `opencodeFreeTierUserAgent` in the config file or
`MODELRELAY_OPENCODE_FREE_TIER_USER_AGENT` in the environment.

**The mode imitates the official OpenCode client, which may conflict with OpenCode's terms of
service, and it can stop working at any time.** modelrelay prints a warning at startup and shows
one in the dashboard while the mode is on — which is the default in this fork. Using it is your
decision and your responsibility.

For hosted Ollama, set `OLLAMA_API_KEY` and optionally override `OLLAMA_BASE_URL` / `OLLAMA_MODEL`.
If you leave the Ollama base URL blank in the UI, modelrelay defaults to `https://ollama.com/v1`.
With a valid Ollama API key, modelrelay will discover available Ollama models automatically.
If you point Ollama at a local host such as `http://127.0.0.1:11434`, modelrelay will also auto-discover models and does not require an API key.

## OpenAI-Compatible endpoints

modelrelay supports configuring multiple OpenAI-compatible upstream endpoints (vLLM, llama.cpp, custom relays, etc.). Each endpoint exposes a single model id and is routed independently.

- In the Web UI, click `+ Add Endpoint` under the **OpenAI-Compatible endpoints** group, supply a name, base URL, model id, and optional API key. Each endpoint then gets its own provider row with status, ping, and rate-limit information.
- modelrelay automatically probes `/v1/models` on each endpoint and exposes every returned model as a routable row. The manually configured model id (if any) is merged in as a fallback. Discovery is on by default and can be toggled per-endpoint with the **"Discover models from `/v1/models`"** checkbox.
- Endpoints are stored in `~/.modelrelay.json` under composite keys like `openai-compatible:my-vllm`:
  ```jsonc
  {
    "apiKeys": {
      "openai-compatible:my-vllm": "sk-…",
      "openai-compatible:groq-clone": "sk-…"
    },
    "providers": {
      "openai-compatible:my-vllm":    { "enabled": true, "name": "Local vLLM", "baseUrl": "http://localhost:8000/v1", "modelId": "qwen-coder" },
      "openai-compatible:groq-clone": { "enabled": true, "name": "Groq Clone", "baseUrl": "https://example/v1",        "modelId": "llama-3.3-70b" }
    }
  }
  ```
- Legacy single-endpoint configs (a bare `openai-compatible` entry without an instance suffix) are migrated automatically to `openai-compatible:default` on first run.
- The legacy env vars `OPENAI_COMPATIBLE_API_KEY` / `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_MODEL` continue to work and apply to the `:default` instance.
- Endpoints can also be managed via the API: `POST /api/openai-compatible/endpoints` (body: `{name, baseUrl, modelId, apiKey?}`) and `DELETE /api/openai-compatible/endpoints/<id>`.

## Config migration (CLI + Web UI)

- In the Web UI, open `Settings` -> `Configuration Transfer` to export/copy/import a token.
- The token includes your full config (including API keys, provider toggles, pinning mode, bans, filter rules, and auto-update settings).
- Treat tokens as secrets. Anyone with the token can import your keys/settings.
- Alternative: copy the config file directly from `~/.modelrelay.json` to the other machine at the same path (`~/.modelrelay.json`).
