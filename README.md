<div align="center">

<img src="https://raw.githubusercontent.com/gschaetz/modelrelay/master/docs/assets/modelrelay-icon.png" alt="modelrelay" width="160">

**[📚 Documentation](https://schaetzkc.com/modelrelay/)** · [npm](https://npmjs.com/package/@schaetzkc/modelrelay) · [Discord](https://discord.gg/AqX6Sawq5w)

[![npm version](https://img.shields.io/npm/v/%40schaetzkc%2Fmodelrelay?color=green&style=flat-square)](https://npmjs.com/package/@schaetzkc/modelrelay)
[![GitHub stars](https://img.shields.io/github/stars/gschaetz/modelrelay?style=flat-square)](https://github.com/gschaetz/modelrelay/stargazers)
[![Join Discord](https://img.shields.io/badge/Join_Discord-5865F2?style=flat-square&logo=discord)](https://discord.gg/AqX6Sawq5w)

</div>

[**Join our Discord**](https://discord.gg/AqX6Sawq5w) for discussions, feature requests, and community support.

<div align="center">
  <img src="https://raw.githubusercontent.com/gschaetz/modelrelay/master/docs/assets/dashboard.png" alt="ModelRelay Dashboard" width="100%">
  <br/>
  <p><i>The smartest, fastest, and completely free local router for your AI coding needs.</i></p>
</div>

---

> **This is a fork.** It is based on [gschaetz/modelrelay](https://github.com/gschaetz/modelrelay) and
> differs from it in one thing: **the OpenCode Zen free models work out of the box.** Upstream ships
> that mode off, because it makes modelrelay imitate the official OpenCode client — which may
> conflict with OpenCode's terms of service. This fork turns it on by default, so the free models
> are routed to without any setup.
>
> Turn it off with `opencodeFreeTierCompat: false` in `~/.modelrelay.json`, or
> `MODELRELAY_OPENCODE_FREE_COMPAT=0`. The reasoning and the measured gate conditions are in
> [docs/free-tiers.md](docs/free-tiers.md).
>
> The upstream-compatible, opt-in version is kept in the branch `feat/opencode-free-tier-compat`
> and upstream pull request [#12](https://github.com/gschaetz/modelrelay/pull/12).

### 🔥 100% Free • Auto-Routing • 80+ Models • 12+ Providers • OpenAI-Compatible

**modelrelay** is an OpenAI-compatible local router that benchmarks free coding models across top providers and automatically forwards your requests to the best available model. 

### ✨ Why use modelrelay?

- 💸 **Completely Free:** Stop paying for API usage. We seamlessly provide access to robust free models.
- 🧠 **State-of-the-Art (SOTA) Models:** Out-of-the-box availability for top-tier models including **Kimi K2.5, Minimax M2.5, GLM 5, Deepseek V3.2**, and more.
- 🏢 **Reliable Providers:** We route requests securely through trusted, high-performance platforms like **NVIDIA, Groq, OpenRouter, OpenCode Zen, Ollama, Kiro, and Google**.
- ⚡ **Lightning Fast:** The built-in benchmark continually evaluates metrics to pick the fastest and most capable LLM for your request.
- 🔄 **OpenAI-Compatible:** A perfect drop-in replacement that works seamlessly with your existing tools, scripts, and workflows.

## 🚀 Install via NPM

```bash
npm install -g @schaetzkc/modelrelay

# Start it
modelrelay
```

Once started, modelrelay is accessible at `http://localhost:7352/`.

Router endpoint:

- Base URL: `http://127.0.0.1:7352/v1`
- API key: any string
- Model: `auto-fastest` (router picks actual backend)

## 🚀 Install via Docker

### Prerequisites
- Docker Engine
- Docker Compose (the `docker compose` command)


```bash
mkdir modelrelay

cd modelrelay

curl -fsSL -o Dockerfile https://raw.githubusercontent.com/gschaetz/modelrelay/master/Dockerfile
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/gschaetz/modelrelay/master/docker-compose.yml

docker compose up -d --build
```

Once running, modelrelay is accessible at `http://localhost:7352/`.

## 🔌 Connect your tools

Run the guided setup to save provider keys and auto-configure OpenClaw or OpenCode:

```bash
modelrelay onboard
```

Prefer to configure by hand? See [Integrations](https://schaetzkc.com/modelrelay/integrations/) (OpenCode) and [OpenClaw](https://schaetzkc.com/modelrelay/openclaw/) for copy-paste configs.

## 🎯 Route by need, not by model name

Free models come and go, so instead of hard-coding one, ask the router for what you need as the request's `model`:

| Model | Routes to |
|---|---|
| `auto-fastest` | the best model overall |
| `tag:coding` | the best available model carrying that tag (`coding`, `reasoning`, `general`, `fast`, `agentic`, or your own) |
| `tag:coding+min_ctx:64k` | same, but only models with at least a 64k context window |
| `auto-fastest+exclude:groq/qwen/qwen3.8-27b` | the best model, never that one |

Details: [Routing](https://schaetzkc.com/modelrelay/routing/) and [Endpoints](https://schaetzkc.com/modelrelay/endpoints/).

## 📊 Reliability-aware

modelrelay tracks how each provider/model behaves on your real requests (successes, rate limits, server errors, dropped streams, latency) and demotes models that keep failing, even if their health pings look fine. Only counts and timings are stored, locally. See [Telemetry](https://schaetzkc.com/modelrelay/telemetry/).

## 📚 Documentation

Full documentation lives at **[schaetzkc.com/modelrelay](https://schaetzkc.com/modelrelay/)**:

- [Integrations](https://schaetzkc.com/modelrelay/integrations/) and [OpenClaw](https://schaetzkc.com/modelrelay/openclaw/)
- [CLI](https://schaetzkc.com/modelrelay/cli/) — commands, autostart, auto-update, config export/import
- [Endpoints](https://schaetzkc.com/modelrelay/endpoints/) — `/v1/chat/completions` and `/v1/models`
- [Routing](https://schaetzkc.com/modelrelay/routing/) — tags, `min_ctx`, `exclude`, QoS
- [Telemetry](https://schaetzkc.com/modelrelay/telemetry/)
- [Dashboard](https://schaetzkc.com/modelrelay/dashboard/) — columns, search syntax, filters, request logs
- [Security](https://schaetzkc.com/modelrelay/security/) — admin token, host checks, binding to this machine only
- [Configuration](https://schaetzkc.com/modelrelay/configuration/) — config file, environment variables, OpenAI-compatible endpoints
- [Troubleshooting](https://schaetzkc.com/modelrelay/troubleshooting/)

---

## Acknowledgments

modelrelay was originally created by [Rolando Rojas](https://github.com/rolandorojas) at [ellipticmarketing/modelrelay](https://github.com/ellipticmarketing/modelrelay). This fork continues active maintenance and development building on that original work.

---

⭐️ If you find modelrelay useful, please consider [starring the repo](https://github.com/gschaetz/modelrelay)!
