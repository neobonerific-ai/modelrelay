/**
 * @file lib/config.js
 * @description JSON config management for modelrelay multi-provider support.
 *
 * 📖 This module manages ~/.modelrelay.json, the config file that
 *    stores API keys and per-provider enabled/disabled state for all providers
 *    (NVIDIA NIM, Groq, Cerebras, etc.).
 *
 * 📖 Config file location: ~/.modelrelay.json
 * 📖 File permissions: 0o600 (user read/write only — contains API keys)
 *
 * 📖 Config JSON structure:
 *   {
 *     "apiKeys": {
 *       "nvidia":     "nvapi-xxx",
 *       "groq":       "gsk_xxx",
 *       "cerebras":   "csk_xxx",
 *       "openrouter": "sk-or-xxx",
 *       "codestral":  "csk-xxx",
 *       "scaleway":   "scw-xxx",
 *       "googleai":   "AIza..."
 *     },
 *     "providers": {
 *       "nvidia":     { "enabled": true },
 *       "groq":       { "enabled": true },
 *       "cerebras":   { "enabled": true },
 *       "openrouter": { "enabled": true },
 *       "codestral":  { "enabled": true },
 *       "scaleway":   { "enabled": true },
 *       "googleai":   { "enabled": true }
 *     }
 *   }
 *
 * 📖 Multi-account round-robin:
 *   apiKeys values can be string | string[].
 *   Array = multiple accounts, rotated per-request with max-turns + 429 backoff.
 *
 * @functions
 *   → loadConfig() — Read ~/.modelrelay.json
 *   → saveConfig(config) — Write config to ~/.modelrelay.json with 0o600 permissions
 *   → getApiKey(config, providerKey) — Get first API key (backward-compatible)
 *   → getApiKeyPool(config, providerKey) — Get all API keys as array
 *   → hasMultipleKeys(config, providerKey) — Whether provider has multiple accounts
 *
 * @exports loadConfig, saveConfig, getApiKey, getApiKeyPool, hasMultipleKeys
 * @exports CONFIG_PATH — path to the JSON config file
 *
 * @see bin/modelrelay.js — main CLI that uses these functions
 * @see sources.js — provider keys come from Object.keys(sources)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { isSafeObjectKey, isWhitespaceChar, trimEndWhile, trimWhile } from './text.js'
import { normalizeTag } from './tags.js'

// 📖 Primary JSON config path — stores all providers' API keys + enabled state
export const CONFIG_PATH = join(homedir(), '.modelrelay.json')
const CONFIG_TRANSFER_PREFIX = 'mrconf:v1:'

// 📖 OpenAI-compatible multi-instance support
// 📖 Each endpoint is keyed as `openai-compatible:<id>` (e.g. `openai-compatible:default`).
// 📖 The bare `openai-compatible` provider key is a template only and is migrated to `:default`.
export const OPENAI_COMPATIBLE_PROVIDER_KEY = 'openai-compatible'
const OPENAI_COMPATIBLE_INSTANCE_PREFIX = `${OPENAI_COMPATIBLE_PROVIDER_KEY}:`
const DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID = 'default'

export function isOpenAICompatibleInstanceKey(providerKey) {
  return typeof providerKey === 'string' && providerKey.startsWith(OPENAI_COMPATIBLE_INSTANCE_PREFIX)
}

export function getBaseProviderKey(providerKey) {
  if (isOpenAICompatibleInstanceKey(providerKey)) return OPENAI_COMPATIBLE_PROVIDER_KEY
  return providerKey
}

export function getOpenAICompatibleInstanceId(providerKey) {
  if (!isOpenAICompatibleInstanceKey(providerKey)) return null
  return providerKey.slice(OPENAI_COMPATIBLE_INSTANCE_PREFIX.length)
}

export function buildOpenAICompatibleInstanceKey(id) {
  // Linear-time edge trim of '-' (the regex form /^-+|-+$/g is quadratic on long runs of '-').
  const trimmed = trimWhile(String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), ch => ch === '-')
  if (!trimmed) return null
  return `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${trimmed}`
}

// 📖 Environment variable names per provider
// 📖 These allow users to override config via env vars (useful for CI/headless setups)
const ENV_VARS = {
  nvidia: 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  codestral: 'CODESTRAL_API_KEY',
  scaleway: 'SCALEWAY_API_KEY',
  googleai: 'GOOGLE_API_KEY',
  kilocode: 'KILOCODE_API_KEY',
}

const PROVIDER_BASE_URL_ENV_VARS = {
  'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
}

const PROVIDER_MODEL_ID_ENV_VARS = {
  'openai-compatible': 'OPENAI_COMPATIBLE_MODEL',
  ollama: 'OLLAMA_MODEL',
}

// The User-Agent the official OpenCode client presents. Overridable, see
// getOpencodeFreeTierUserAgent.
export const DEFAULT_OPENCODE_USER_AGENT = 'opencode/1.19.3';

export function normalizeSecret(value) {
  return typeof value === 'string'
    ? trimEndWhile(value, ch => isWhitespaceChar(ch) || (ch >= '\u2580' && ch <= '\u259F')).trim()
    : ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 📖 loadConfig: Read the JSON config from disk.
 *
 * 📖 Fallback chain:
 *   1. Try to read ~/.modelrelay.json
 *   2. If missing or invalid, return an empty default config
 *
 * @returns {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, bannedModels: string[], autoUpdate: { enabled: boolean, intervalHours: number, lastCheckAt: string|null, lastUpdateAt: string|null, lastVersionApplied: string|null, lastError: string|null }, minSweScore: number|null, excludedProviders: string[] }}
 */
export function loadConfig() {
  const current = _readConfigFile(CONFIG_PATH)
  if (current) return current

  return _emptyConfig()
}

/**
 * 📖 saveConfig: Write the config object to ~/.modelrelay.json.
 *
 * 📖 Uses mode 0o600 so the file is only readable by the owning user (API keys!).
 * 📖 Pretty-prints JSON for human readability.
 *
 * @param {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}> }} config
 */
export function saveConfig(config) {
  try {
    const normalized = normalizeConfigShape(config)
    writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), { mode: 0o600 })
  } catch {
    // 📖 Silently fail — the app is still usable, keys just won't persist
  }
}

export function exportConfigToken(config) {
  const normalized = normalizeConfigShape(config)
  const json = JSON.stringify(normalized)
  const encoded = Buffer.from(json, 'utf8').toString('base64url')
  return `${CONFIG_TRANSFER_PREFIX}${encoded}`
}

export function importConfigToken(token) {
  const raw = typeof token === 'string' ? token.trim() : ''
  if (!raw) throw new Error('Config token is empty.')

  let parsed = null

  if (raw.startsWith('{')) {
    parsed = JSON.parse(raw)
  } else if (raw.startsWith(CONFIG_TRANSFER_PREFIX)) {
    const encoded = raw.slice(CONFIG_TRANSFER_PREFIX.length)
    if (!encoded) throw new Error('Config token payload is missing.')
    const json = Buffer.from(encoded, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } else {
    // Backward-compatible import path for plain base64 payloads.
    const json = Buffer.from(raw, 'base64').toString('utf8')
    parsed = JSON.parse(json)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config payload must be a JSON object.')
  }

  return normalizeConfigShape(parsed)
}

/**
 * 📖 getApiKey: Get the effective API key for a provider.
 *
 * 📖 Priority order (first non-empty wins):
 *   1. Environment variable (e.g. NVIDIA_API_KEY) — for CI/headless
 *   2. Config file value — from ~/.modelrelay.json
 *   3. null — no key configured
 *
 * @param {{ apiKeys: Record<string,string> }} config
 * @param {string} providerKey — e.g. 'nvidia', 'groq', 'cerebras'
 * @returns {string|null}
 */
export function getApiKey(config, providerKey) {
  // 📖 Env var override — takes precedence over everything
  const envVar = ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, ENV_VARS)
  if (envVar && process.env[envVar]) {
    return normalizeSecret(process.env[envVar]);
  }
  // 📖 Config file value (string or array — return first element)
  const key = config?.apiKeys?.[providerKey]
  if (Array.isArray(key)) return normalizeSecret(key[0]) || null
  if (key) return normalizeSecret(key)
  return null
}

/**
 * 📖 getApiKeyPool: Get all configured API keys for a provider.
 * Returns an array of keys. Env var override returns single-element array.
 * @param {object} config
 * @param {string} providerKey
 * @returns {string[]}
 */
export function getApiKeyPool(config, providerKey) {
  const envVar = ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, ENV_VARS)
  if (envVar && process.env[envVar]) {
    const k = normalizeSecret(process.env[envVar])
    return k ? [k] : []
  }
  const raw = config?.apiKeys?.[providerKey]
  if (Array.isArray(raw)) return raw.map(normalizeSecret).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) return [normalizeSecret(raw)]
  return []
}

/**
 * 📖 hasMultipleKeys: Check if a provider has multiple API key accounts.
 * @param {object} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function hasMultipleKeys(config, providerKey) {
  return getApiKeyPool(config, providerKey).length > 1
}

/**
 * 📖 getMaxTurns: Get the per-account max-turns threshold for a provider.
 * When an account reaches this many requests, rotate to the next one
 * (proactive switching before hitting rate limits).
 * @param {object} config
 * @param {string} providerKey
 * @returns {number} 0 = no limit
 */
export function getMaxTurns(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) return 0
  const val = Number(providerConfig.maxTurns)
  if (!Number.isFinite(val) || val < 1) return 0
  return Math.floor(val)
}

export function getProviderBaseUrl(config, providerKey) {
  const envVar = PROVIDER_BASE_URL_ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, PROVIDER_BASE_URL_ENV_VARS)
  if (envVar && process.env[envVar]) {
    return normalizeText(process.env[envVar]) || null
  }

  const baseUrl = config?.providers?.[providerKey]?.baseUrl
  return normalizeText(baseUrl) || null
}

export function getProviderModelId(config, providerKey) {
  const envVar = PROVIDER_MODEL_ID_ENV_VARS[providerKey] || _legacyOpenAICompatibleEnvVar(providerKey, PROVIDER_MODEL_ID_ENV_VARS)
  if (envVar && process.env[envVar]) {
    return normalizeText(process.env[envVar]) || null
  }

  const modelId = config?.providers?.[providerKey]?.modelId
  return normalizeText(modelId) || null
}

// 📖 Legacy OPENAI_COMPATIBLE_* env vars apply to the `:default` instance.
function _legacyOpenAICompatibleEnvVar(providerKey, envMap) {
  if (providerKey === `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID}`) {
    return envMap[OPENAI_COMPATIBLE_PROVIDER_KEY] || null
  }
  return null
}

/**
 * 📖 listOpenAICompatibleEndpoints: Return all configured OpenAI-compatible endpoints.
 *
 * Walks `config.providers` for keys that start with `openai-compatible:` and pairs them
 * with their api keys from `config.apiKeys`. Stable insertion order.
 *
 * @param {object} config
 * @returns {Array<{instanceKey:string,id:string,name:string,baseUrl:string,modelId:string,apiKey:string|null,enabled:boolean}>}
 */
export function listOpenAICompatibleEndpoints(config) {
  const providers = (config && config.providers && typeof config.providers === 'object') ? config.providers : {}
  const out = []
  const defaultKey = `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID}`
  let sawDefault = false
  for (const key of Object.keys(providers)) {
    if (!isOpenAICompatibleInstanceKey(key)) continue
    if (key === defaultKey) sawDefault = true
    const p = providers[key] || {}
    out.push({
      instanceKey: key,
      id: getOpenAICompatibleInstanceId(key),
      name: normalizeText(p.name) || getOpenAICompatibleInstanceId(key),
      baseUrl: getProviderBaseUrl(config, key) || '',
      modelId: getProviderModelId(config, key) || '',
      apiKey: getApiKey(config, key),
      enabled: p.enabled !== false,
      discoverModels: p.discoverModels !== false,
    })
  }

  // 📖 Surface a virtual `:default` instance when only the legacy env vars
  // 📖 OPENAI_COMPATIBLE_* are set (no JSON entry). Keeps the UI consistent
  // 📖 with prior behavior where env-var-only users still saw the provider row.
  if (!sawDefault) {
    const envBaseUrl = getProviderBaseUrl(config, defaultKey)
    const envModelId = getProviderModelId(config, defaultKey)
    const envApiKey = getApiKey(config, defaultKey)
    if (envBaseUrl || envModelId || envApiKey) {
      out.push({
        instanceKey: defaultKey,
        id: DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID,
        name: 'Default',
        baseUrl: envBaseUrl || '',
        modelId: envModelId || '',
        apiKey: envApiKey,
        enabled: true,
        discoverModels: true,
      })
    }
  }
  return out
}

/**
 * 📖 upsertOpenAICompatibleEndpoint: Add or update an endpoint instance in-place.
 *
 * @param {object} config
 * @param {{id?:string, instanceKey?:string, name?:string, baseUrl?:string, modelId?:string, apiKey?:string|null, enabled?:boolean}} fields
 * @returns {string} the instanceKey written
 */
export function upsertOpenAICompatibleEndpoint(config, fields) {
  if (!config || typeof config !== 'object') throw new Error('config required')
  if (!config.apiKeys || typeof config.apiKeys !== 'object') config.apiKeys = {}
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}

  let instanceKey = fields?.instanceKey
  if (!instanceKey) instanceKey = buildOpenAICompatibleInstanceKey(fields?.id || fields?.name || '')
  if (!instanceKey) throw new Error('endpoint id or name required')

  const existing = config.providers[instanceKey] || {}
  const merged = { ...existing }
  if (fields.name !== undefined) merged.name = normalizeText(fields.name)
  if (fields.baseUrl !== undefined) merged.baseUrl = normalizeText(fields.baseUrl)
  if (fields.modelId !== undefined) merged.modelId = normalizeText(fields.modelId)
  if (fields.enabled !== undefined) merged.enabled = fields.enabled !== false
  if (fields.discoverModels !== undefined) {
    if (fields.discoverModels === false) merged.discoverModels = false
    else delete merged.discoverModels
  }
  config.providers[instanceKey] = merged

  if (fields.apiKey !== undefined) {
    if (fields.apiKey === null || fields.apiKey === '') {
      delete config.apiKeys[instanceKey]
    } else {
      config.apiKeys[instanceKey] = normalizeSecret(fields.apiKey)
    }
  }

  return instanceKey
}

/**
 * 📖 removeOpenAICompatibleEndpoint: Delete an endpoint instance and its API key entry.
 *
 * @param {object} config
 * @param {string} instanceKey
 * @returns {boolean} true if anything was removed
 */
export function removeOpenAICompatibleEndpoint(config, instanceKey) {
  if (!isOpenAICompatibleInstanceKey(instanceKey)) return false
  let removed = false
  if (config?.providers && instanceKey in config.providers) {
    delete config.providers[instanceKey]
    removed = true
  }
  if (config?.apiKeys && instanceKey in config.apiKeys) {
    delete config.apiKeys[instanceKey]
    removed = true
  }
  return removed
}

/**
 * 📖 isProviderEnabled: Check if a provider is enabled in config.
 *
 * 📖 Providers are enabled by default if not explicitly set to false.
 * 📖 A provider without an API key should still appear in settings (just can't ping).
 *
 * @param {{ providers: Record<string,{enabled:boolean}> }} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function isProviderEnabled(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) {
    if (providerKey === 'kilocode') return false // 📖 KiloCode: disabled by default
    return true // 📖 Default: enabled
  }
  return providerConfig.enabled !== false
}

export function getProviderPingIntervalMs(config, providerKey) {
  const DEFAULT_PING_INTERVAL_MS = 30 * 60_000
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig?.pingIntervalMinutes) return DEFAULT_PING_INTERVAL_MS
  const mins = Number(providerConfig.pingIntervalMinutes)
  if (!Number.isFinite(mins) || mins < 1) return DEFAULT_PING_INTERVAL_MS
  return mins * 60_000
}

export function isAutoPingEnabled(config) {
  if (config?.autoPingEnabled === false) return false
  return true
}

export function getPinningMode(config) {
  return config?.pinningMode === 'exact' ? 'exact' : 'canonical'
}

// 📖 OpenCode Zen free-tier compatibility.
//
// OpenCode's free models are gated by the *request shape* they expect from
// the official client: a matching User-Agent, a session id in a specific
// format, `stream: true` and a tool named exactly `read`. ModelRelay does not
// imitate that client by default — the free tier is documented as a constraint
// we respect.
//
// A user who explicitly accepts that can opt in, at their own responsibility.
// The env var takes precedence over the config file, matching the other
// settings in this module.
const OPENCODE_FREE_COMPAT_ENV_VAR = 'MODELRELAY_OPENCODE_FREE_COMPAT';

// This fork ships with the OpenCode Zen free-tier compatibility mode enabled,
// so the free models are routable out of the box. Set
// `opencodeFreeTierCompat: false` in ~/.modelrelay.json, or
// MODELRELAY_OPENCODE_FREE_COMPAT=0, to turn it off.
export const OPENCODE_FREE_COMPAT_DEFAULT = true;

// The latency the QoS score treats as "fast enough". Slower than this loses score, faster does
// not gain any -- so a higher target weights intelligence over latency more strongly.
export const DEFAULT_QOS_LATENCY_TARGET_MS = 3000

// 📖 Only these spellings enable the flag. Anything else (including an empty
// string, '0', 'false' and 'no') leaves it off, so a typo cannot silently
// enable request rewriting.
const OPENCODE_FREE_COMPAT_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

function parseOpencodeFreeCompatValue(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return OPENCODE_FREE_COMPAT_ENABLED_VALUES.has(value.trim().toLowerCase());
}

/**
 * 📖 isOpencodeFreeTierCompatEnabled: Is the OpenCode Zen free-tier
 * compatibility mode on?
 *
 * Off by default. The env var wins over the config file.
 *
 * @param {object} config
 * @returns {boolean}
 */
export function isOpencodeFreeTierCompatEnabled(config) {
  const envValue = process.env[OPENCODE_FREE_COMPAT_ENV_VAR];
  if (envValue !== undefined && envValue !== '') {
    return parseOpencodeFreeCompatValue(envValue);
  }
  const configured = config?.opencodeFreeTierCompat;
  if (configured === undefined || configured === null) {
    return OPENCODE_FREE_COMPAT_DEFAULT;
  }
  return parseOpencodeFreeCompatValue(configured);
}

/**
 * 📖 getOpencodeFreeTierUserAgent: The User-Agent to present to OpenCode Zen
 * when the compatibility mode is on.
 *
 * Overridable so a stale default can be fixed without a release: set
 * `opencodeFreeTierUserAgent` in the config file or
 * `MODELRELAY_OPENCODE_FREE_TIER_USER_AGENT` in the environment.
 *
 * @param {object} config
 * @returns {string}
 */
export function getOpencodeFreeTierUserAgent(config) {
  const envValue = process.env.MODELRELAY_OPENCODE_FREE_TIER_USER_AGENT;
  const fromEnv = normalizeText(envValue);
  if (fromEnv) return fromEnv;
  const fromConfig = normalizeText(config?.opencodeFreeTierUserAgent);
  if (fromConfig) return fromConfig;
  return DEFAULT_OPENCODE_USER_AGENT;
}

// 📖 Internal helper: create a blank config with the right shape
function _emptyConfig() {
  return {
    apiKeys: {},
    providers: {},
    bannedModels: [],
    autoUpdate: {
      enabled: true,
      intervalHours: 24,
      lastCheckAt: null,
      lastUpdateAt: null,
      lastVersionApplied: null,
      lastError: null,
    },
    minSweScore: null,
    excludedProviders: [],
    pinningMode: 'canonical',
    modelTags: {},
  }
}

function _readConfigFile(path) {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return normalizeConfigShape(parsed)
  } catch {
    return null
  }
}

// How many alternative models the router tries before it gives up on a request. Upstream used
// 5; a deeper pool matters when the good models are rate-limited at the same time.
export const DEFAULT_MAX_PROACTIVE_RETRIES = 12

// Quality percentile assumed for a model without benchmark data. Upstream used 0, which ranked
// every unrated model behind every rated one.
export const DEFAULT_QOS_UNRATED_QUALITY_FLOOR = 35

export function getMaxProactiveRetries(config) {
  const value = Number(config?.maxProactiveRetries)
  if (!Number.isFinite(value)) return DEFAULT_MAX_PROACTIVE_RETRIES
  return Math.min(50, Math.max(1, Math.trunc(value)))
}

export function getQosUnratedQualityFloor(config) {
  const value = Number(config?.qosUnratedQualityFloor)
  if (!Number.isFinite(value)) return DEFAULT_QOS_UNRATED_QUALITY_FLOOR
  return Math.min(100, Math.max(0, value))
}

export function normalizeConfigShape(config) {
  const base = config && typeof config === 'object' && !Array.isArray(config)
    ? { ...config }
    : {}

  if (!base.apiKeys || typeof base.apiKeys !== 'object' || Array.isArray(base.apiKeys)) {
    base.apiKeys = {}
  }
  if (!base.providers || typeof base.providers !== 'object' || Array.isArray(base.providers)) {
    base.providers = {}
  }
  if (!Array.isArray(base.bannedModels)) base.bannedModels = []

  if (!base.autoUpdate || typeof base.autoUpdate !== 'object' || Array.isArray(base.autoUpdate)) {
    base.autoUpdate = {}
  }
  if (base.autoUpdate.enabled == null) base.autoUpdate.enabled = true
  if (!Number.isFinite(base.autoUpdate.intervalHours) || base.autoUpdate.intervalHours <= 0) base.autoUpdate.intervalHours = 24
  if (!('lastCheckAt' in base.autoUpdate)) base.autoUpdate.lastCheckAt = null
  if (!('lastUpdateAt' in base.autoUpdate)) base.autoUpdate.lastUpdateAt = null
  if (!('lastVersionApplied' in base.autoUpdate)) base.autoUpdate.lastVersionApplied = null
  if (!('lastError' in base.autoUpdate)) base.autoUpdate.lastError = null

  if (!('minSweScore' in base) || base.minSweScore === null) base.minSweScore = null
  else if (typeof base.minSweScore === 'number' && base.minSweScore >= 0 && base.minSweScore <= 1) base.minSweScore = base.minSweScore
  else base.minSweScore = null

  if (!Array.isArray(base.excludedProviders)) base.excludedProviders = []

  // How many alternative models the router may try before giving up on a request.
  // Each retry is a different model, so this is also the depth of the pool the router
  // can reach when the better models are rate-limited.
  if (!Number.isFinite(base.maxProactiveRetries)) base.maxProactiveRetries = DEFAULT_MAX_PROACTIVE_RETRIES
  else base.maxProactiveRetries = Math.min(50, Math.max(1, Math.trunc(base.maxProactiveRetries)))

  // Quality percentile (0-100) assumed for a model that has no benchmark score. Zero means
  // "unknown ranks last", which is the upstream behaviour.
  if (!Number.isFinite(base.qosUnratedQualityFloor)) base.qosUnratedQualityFloor = DEFAULT_QOS_UNRATED_QUALITY_FLOOR
  else base.qosUnratedQualityFloor = Math.min(100, Math.max(0, base.qosUnratedQualityFloor))

  if (!Number.isFinite(base.qosLatencyTargetMs) || base.qosLatencyTargetMs <= 0) {
    base.qosLatencyTargetMs = DEFAULT_QOS_LATENCY_TARGET_MS
  }
  base.pinningMode = base.pinningMode === 'exact' ? 'exact' : 'canonical'
  // The OpenCode free-tier compatibility flag is a boolean. A string value is
  // accepted only when it spells out an enabled state; anything else is off.
  // An unset value stays unset, so the built-in default applies.
  if (base.opencodeFreeTierCompat === undefined || base.opencodeFreeTierCompat === null) {
    delete base.opencodeFreeTierCompat;
  } else {
    base.opencodeFreeTierCompat = parseOpencodeFreeCompatValue(base.opencodeFreeTierCompat);
  }
  if (typeof base.opencodeFreeTierUserAgent !== 'string') base.opencodeFreeTierUserAgent = ''
  else base.opencodeFreeTierUserAgent = base.opencodeFreeTierUserAgent.trim()
  if (!base.modelTags || typeof base.modelTags !== 'object' || Array.isArray(base.modelTags)) {
    base.modelTags = {}
  } else {
    const normalizedModelTags = {}
    for (const [modelId, tags] of Object.entries(base.modelTags)) {
      if (typeof modelId !== 'string' || !Array.isArray(tags)) continue
      const modelKey = modelId.trim().toLowerCase()
      if (!isSafeObjectKey(modelKey)) continue
      const normalizedTags = [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, 20)
      if (normalizedTags.length > 0) normalizedModelTags[modelKey] = normalizedTags
    }
    base.modelTags = normalizedModelTags
  }

  // Trim API key strings to avoid copy/paste artifacts.
  for (const provider in base.apiKeys) {
    const val = base.apiKeys[provider]
    if (Array.isArray(val)) {
      base.apiKeys[provider] = val.map(normalizeSecret).filter(Boolean)
    } else if (typeof val === 'string') {
      base.apiKeys[provider] = normalizeSecret(val)
    }
  }

  for (const provider in base.providers) {
    const providerConfig = base.providers[provider]
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
      base.providers[provider] = {}
      continue
    }
    if (typeof providerConfig.baseUrl === 'string') {
      providerConfig.baseUrl = normalizeText(providerConfig.baseUrl)
    }
    if (typeof providerConfig.modelId === 'string') {
      providerConfig.modelId = normalizeText(providerConfig.modelId)
    }
    if (typeof providerConfig.name === 'string') {
      providerConfig.name = normalizeText(providerConfig.name)
    }
  }

  _migrateLegacyOpenAICompatible(base)

  return base
}

// 📖 Legacy single-instance config (`openai-compatible` provider key with baseUrl/modelId
// 📖 fields, and apiKey at apiKeys['openai-compatible']) is migrated to the canonical
// 📖 instance key `openai-compatible:default`. The bare key is stripped after migration.
function _migrateLegacyOpenAICompatible(base) {
  const legacyProvider = base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
  const legacyKey = base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
  const hasLegacyConfig =
    (legacyProvider && (legacyProvider.baseUrl || legacyProvider.modelId || legacyProvider.enabled === false || legacyProvider.maxTurns)) ||
    (legacyKey && (typeof legacyKey === 'string' ? legacyKey.trim() : (Array.isArray(legacyKey) && legacyKey.length > 0)))

  if (!hasLegacyConfig) {
    // Drop empty bare entry if present so it doesn't shadow lookups.
    delete base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
    delete base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
    return
  }

  const targetKey = `${OPENAI_COMPATIBLE_INSTANCE_PREFIX}${DEFAULT_OPENAI_COMPATIBLE_INSTANCE_ID}`
  // Don't clobber an explicit :default the user has already configured.
  if (base.providers[targetKey] || base.apiKeys[targetKey]) {
    delete base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
    delete base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
    return
  }

  if (legacyProvider) {
    const merged = { ...legacyProvider }
    if (!merged.name) merged.name = 'Default'
    base.providers[targetKey] = merged
  } else {
    base.providers[targetKey] = { name: 'Default' }
  }

  if (legacyKey != null) base.apiKeys[targetKey] = legacyKey

  delete base.providers[OPENAI_COMPATIBLE_PROVIDER_KEY]
  delete base.apiKeys[OPENAI_COMPATIBLE_PROVIDER_KEY]
}
