import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { cleanModelDisplayLabel as cleanModelDisplayLabelForSafetyTests, sources, MODELS, canonicalizeModelId, getPreferredModelContext, getPreferredModelLabel, getScore, resolveAliasedModelId } from '../sources.js'
import { TAG_VOCABULARY, MODEL_TAGS, getModelTags as getBuiltInModelTags } from '../tags.js'
import {
  getAvg,
  getVerdict,
  getUptime,
  sortResults,
  findBestModel,
  rankModelsForRouting,
  getRoutingModelKey,
  latencyScore,
  computeQoS,
  DEFAULT_QOS_LATENCY_TARGET_MS,
  buildModelGroups,
  filterModelsByRequested,
  getEffectiveContext,
  MAX_REQUESTED_MODEL_LENGTH,
  normalizeRequestedModel,
  isCompleteSseStream,
  isProviderRequestRejectionError,
  isRateLimitShapedError,
  isModelScopedError,
  computeQoSMap,
  isRetryableProxyStatus,
  isErrorShapedFirstSseEvent,
  peekFirstSseEvent,
  computeFailedRefreshRetryAt,
  parseContextSize,
  parseArgs,
  parseOpenRouterKeyRateLimit,
  selectNextApiKeyFromPool,
  VERDICT_ORDER,
  isModelEligibleForRouting,
} from '../lib/utils.js';
import { classifyFailureStatus, createTelemetryStore, getReliability, normalizeTelemetryStore, recordFailure, recordSuccess, reliabilityMultiplier, summarizeTelemetry, summarizeTelemetryEntry, TELEMETRY_HALF_LIFE_MS, TELEMETRY_MIN_MULTIPLIER } from '../lib/telemetry.js'
import http from 'node:http'
import express from 'express'
import { SESSION_COOKIE, buildClearedCookie, buildSessionCookie, createAdminAuth, createAdminMiddleware, createAuthRoutes, evaluateRequestOrigin, isAllowedHost, parseAllowedHosts, parseAllowedOrigins, parseCookies, parseHostHeader } from '../lib/admin-guard.js'
import '../public/model-search.js'
import { capLength, isSafeObjectKey, stripTrailingSuffixes, trimEndWhile, trimStartWhile, trimWhile } from '../lib/text.js'
import { OPENCLAW_ROUTING_PRESETS, applyOpenClawConfig, buildOpenClawProviderConfig } from '../lib/onboard.js'
import { normalizeMissingScoreId } from '../lib/score-fetcher.js'
import { buildOpenRouterQualityIndex, fitLinearRegression, qualityLookupKeys, resolveModelQuality } from '../lib/model-quality.js'
import { getConfiguredTagNames, getModelTagKey, getModelTags as getUserModelTags, normalizeTag, normalizeTags, setModelTags } from '../lib/tags.js'
import { resolveAutostartExecPath, resolveAutostartNodePath } from '../lib/autostart.js'
import { normalizeSecret, buildOpenAICompatibleInstanceKey as buildInstanceKeyForSafetyTests, exportConfigToken, getApiKey, getApiKeyPool, getMaxTurns, getPinningMode, getProviderBaseUrl, getProviderModelId, getProviderPingIntervalMs, hasMultipleKeys, importConfigToken, normalizeConfigShape, isOpenAICompatibleInstanceKey, getBaseProviderKey, getOpenAICompatibleInstanceId, buildOpenAICompatibleInstanceKey, listOpenAICompatibleEndpoints, upsertOpenAICompatibleEndpoint, removeOpenAICompatibleEndpoint, isOpencodeFreeTierCompatEnabled, getOpencodeFreeTierUserAgent, getQosUnratedQualityFloor, getMaxProactiveRetries, DEFAULT_OPENCODE_USER_AGENT } from '../lib/config.js';
import { buildNpmInstallInvocation, buildWindowsPostUpdateRestartCommand, getForcedUpdateVersion, getLocalUpdateTarballPath, getLocalUpdateVersion, isRunningFromSource, shouldStopAutostartBeforeUpdate } from '../lib/update.js'
import { isKnownProviderKey, captureProxyRateLimit, buildKiroRequestPayload, buildKiroSocialLoginUrl, buildOpencodeHeaders, buildOpencodeProjectId, buildProviderRequestBody, buildProviderRequestHeaders, exchangeKiroSocialAuthFlow, exchangeKiroSocialCode, extractKiroEmailFromAccessToken, extractOllamaModelRecords, extractOpenAICompatibleModelRecords, buildOpenAICompatibleModelsListUrl, getAccountStatus, getKiroRefreshToken, hasKiroAuthConfigured, getPinnedModelCandidate, getPinnedModelMatches, isProviderAuthOptional, isProviderBearerAuthEnabled, parseKiroEventFrame, pollKiroBuilderIdToken, providerWantsBearerAuth, resolveKiroOAuthAccessToken, shouldRetryOptionalProviderWithBearer, startKiroBuilderIdDeviceAuth, startKiroSocialAuthFlow, toOllamaModelMeta, toOpenAICompatibleDiscoveredModelMeta, toOpenCodeModelMeta, toOpenRouterModelMeta, toKiloCodeModelMeta, transformKiroResponse, buildOpencodeFreeTierPayload, stripInjectedToolCalls, stripInjectedToolCallsFromSseChunk, collectOpencodeStreamAsJson, OPENCODE_INJECTED_READ_TOOL, OPENCODE_FREE_COMPAT_WARNING, isOpencodeFreeModelUnsupported, buildPingRequest, buildOpencodeCompatOptions } from '../lib/server.js';
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function mockResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'test/model',
    label: 'Test Model',
    providerKey: 'nvidia',
    intell: 10,
    ctx: '128k',
    status: 'up',
    pings: [],
    httpCode: null,
    ...overrides,
  }
}

function withEnv(overrides, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }

  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const TEST_CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  TEST_CRC32_TABLE[i] = c >>> 0
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = TEST_CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function encodeKiroFrame(headers, payload) {
  const encoder = new TextEncoder()
  const encodedHeaders = Object.entries(headers).map(([name, value]) => ({
    nameBytes: encoder.encode(name),
    valueBytes: encoder.encode(String(value)),
  }))
  const headersLength = encodedHeaders.reduce((sum, header) => sum + 1 + header.nameBytes.length + 1 + 2 + header.valueBytes.length, 0)
  const payloadBytes = encoder.encode(payload == null ? '' : JSON.stringify(payload))
  const totalLength = 12 + headersLength + payloadBytes.length + 4
  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)

  view.setUint32(0, totalLength, false)
  view.setUint32(4, headersLength, false)
  view.setUint32(8, crc32(frame.slice(0, 8)), false)

  let offset = 12
  for (const { nameBytes, valueBytes } of encodedHeaders) {
    frame[offset] = nameBytes.length
    offset += 1
    frame.set(nameBytes, offset)
    offset += nameBytes.length
    frame[offset] = 7
    offset += 1
    frame[offset] = (valueBytes.length >> 8) & 0xff
    frame[offset + 1] = valueBytes.length & 0xff
    offset += 2
    frame.set(valueBytes, offset)
    offset += valueBytes.length
  }
  frame.set(payloadBytes, offset)

  view.setUint32(totalLength - 4, crc32(frame.slice(0, totalLength - 4)), false)
  return frame
}

function encodeKiroEventFrame(eventType, payload) {
  return encodeKiroFrame({ ':event-type': eventType }, payload)
}

describe('config helpers', () => {
  it('resolves provider-specific ping intervals', () => {
    const config = {
      providers: {
        nvidia: { pingIntervalMinutes: 5 },
        kilocode: { pingIntervalMinutes: '10' },
        openrouter: { pingIntervalMinutes: 0 }, // invalid
      }
    }

    assert.equal(getProviderPingIntervalMs(config, 'nvidia'), 5 * 60_000)
    assert.equal(getProviderPingIntervalMs(config, 'kilocode'), 10 * 60_000)
    assert.equal(getProviderPingIntervalMs(config, 'openrouter'), 30 * 60_000) // default
    assert.equal(getProviderPingIntervalMs(config, 'missing'), 30 * 60_000) // default
    assert.equal(getPinningMode(config), 'canonical')
  })

  it('exports/imports full config through transfer token', () => {
    const config = {
      apiKeys: { nvidia: '  nv-key  ', groq: 'gsk-key' },
      providers: { nvidia: { enabled: true }, groq: { enabled: false } },
      bannedModels: ['a', 'b'],
      autoUpdate: { enabled: true, intervalHours: 12 },
      minSweScore: 0.45,
      excludedProviders: ['openrouter'],
      pinningMode: 'exact',
    }

    const token = exportConfigToken(config)
    assert.equal(token.startsWith('mrconf:v1:'), true)

    const imported = importConfigToken(token)
    assert.equal(imported.apiKeys.nvidia, 'nv-key')
    assert.equal(imported.apiKeys.groq, 'gsk-key')
    assert.equal(imported.providers.groq.enabled, false)
    assert.deepEqual(imported.bannedModels, ['a', 'b'])
    assert.equal(imported.autoUpdate.intervalHours, 12)
    assert.equal(imported.minSweScore, 0.45)
    assert.deepEqual(imported.excludedProviders, ['openrouter'])
    assert.equal(imported.pinningMode, 'exact')
  })

  it('imports legacy plain-base64 config payloads', () => {
    const json = JSON.stringify({ apiKeys: { kilocode: 'abc' }, providers: {} })
    const plainBase64 = Buffer.from(json, 'utf8').toString('base64')
    const imported = importConfigToken(plainBase64)
    assert.equal(imported.apiKeys.kilocode, 'abc')
  })
})

describe('sources data integrity', () => {
  it('does not include the removed Qwen Code provider', () => {
    assert.equal('qwencode' in sources, false)
  })

  it('includes OpenAI-compatible provider', () => {
    assert.ok(sources['openai-compatible'])
    assert.equal(sources['openai-compatible'].name, 'OpenAI-Compatible')
    assert.ok(Array.isArray(sources['openai-compatible'].models))
  })

  it('includes Ollama provider', () => {
    assert.ok(sources.ollama)
    assert.equal(sources.ollama.name, 'Ollama')
    assert.ok(Array.isArray(sources.ollama.models))
  })

  it('includes OpenCode Zen provider', () => {
    assert.ok(sources.opencode)
    assert.equal(sources.opencode.name, 'OpenCode Zen')
    assert.ok(Array.isArray(sources.opencode.models))
  })

  it('includes Kiro provider', () => {
    assert.ok(sources.kiro)
    assert.equal(sources.kiro.name, 'Kiro')
    assert.ok(Array.isArray(sources.kiro.models))
  })

  it('does not enable discovery for Codestral because its API has no models endpoint', () => {
    assert.equal(sources.codestral.discoverable, undefined)
  })

  it('has expected provider structure', () => {
    for (const [providerKey, provider] of Object.entries(sources)) {
      assert.equal(typeof providerKey, 'string')
      assert.equal(typeof provider.name, 'string')
      assert.equal(typeof provider.url, 'string')
      assert.ok(Array.isArray(provider.models))
    }
  })

  it('provider model tuples have 3 fields', () => {
    for (const provider of Object.values(sources)) {
      for (const model of provider.models) {
        assert.ok(Array.isArray(model))
        assert.equal(model.length, 3)
        assert.equal(typeof model[0], 'string')
        assert.equal(typeof model[1], 'string')
        assert.equal(typeof model[2], 'string')
      }
    }
  })

  it('flat MODELS tuples include context provenance', () => {
    for (const model of MODELS) {
      assert.ok(Array.isArray(model))
      assert.equal(model.length, 7)
      assert.equal(typeof model[0], 'string')
      assert.equal(typeof model[1], 'string')
      assert.equal(typeof model[4], 'string')
      assert.equal(model[5], 'curated')
      assert.equal(typeof model[6], 'string')
    }
  })

  it('flat MODELS count matches sources sum', () => {
    const sum = Object.values(sources).reduce((acc, provider) => acc + provider.models.length, 0)
    assert.equal(MODELS.length, sum)
  })

  it('has no duplicate provider/model IDs', () => {
    const seen = new Set()
    for (const [modelId, , , , providerKey] of MODELS) {
      const key = `${providerKey}/${modelId}`
      assert.equal(seen.has(key), false, `Duplicate model key found: ${key}`)
      seen.add(key)
    }
  })
})

describe('tags data integrity', () => {
  const knownModelIds = new Set(MODELS.map(([modelId]) => modelId))

  it('has no duplicate entries in TAG_VOCABULARY', () => {
    assert.equal(TAG_VOCABULARY.length, new Set(TAG_VOCABULARY).size)
  })

  it('only assigns tags that are in TAG_VOCABULARY', () => {
    for (const [modelId, tags] of Object.entries(MODEL_TAGS)) {
      for (const tag of tags) {
        assert.ok(TAG_VOCABULARY.includes(tag), `Unknown tag "${tag}" on ${modelId}`)
      }
    }
  })

  it('does not assign duplicate tags to the same model', () => {
    for (const [modelId, tags] of Object.entries(MODEL_TAGS)) {
      assert.equal(tags.length, new Set(tags).size, `Duplicate tag on ${modelId}`)
    }
  })

  it('only keys MODEL_TAGS by model IDs that exist in sources.js', () => {
    for (const modelId of Object.keys(MODEL_TAGS)) {
      assert.ok(knownModelIds.has(modelId), `MODEL_TAGS has a stale key: ${modelId}`)
    }
  })

  it('assigns at least one tag to every model in sources.js', () => {
    for (const modelId of knownModelIds) {
      assert.ok(getBuiltInModelTags(modelId).length > 0, `No tags assigned to ${modelId}`)
    }
  })
})

describe('provider api key resolution', () => {
  it('does not resolve the removed Qwen Code provider from env vars', () => {
    const originalQwen = process.env.QWEN_CODE_API_KEY
    const originalDashScope = process.env.DASHSCOPE_API_KEY

    try {
      delete process.env.QWEN_CODE_API_KEY
      delete process.env.DASHSCOPE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)

      process.env.DASHSCOPE_API_KEY = 'dashscope-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)

      process.env.QWEN_CODE_API_KEY = 'qwen-code-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)
    } finally {
      if (originalQwen == null) delete process.env.QWEN_CODE_API_KEY
      else process.env.QWEN_CODE_API_KEY = originalQwen

      if (originalDashScope == null) delete process.env.DASHSCOPE_API_KEY
      else process.env.DASHSCOPE_API_KEY = originalDashScope
    }
  })

  it('supports KiloCode provider env var override', () => {
    const original = process.env.KILOCODE_API_KEY

    try {
      delete process.env.KILOCODE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'kilocode'), null)

      process.env.KILOCODE_API_KEY = 'kilocode-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'kilocode'), 'kilocode-env-key')

      assert.equal(getApiKey({ apiKeys: { kilocode: 'file-key' } }, 'kilocode'), 'kilocode-env-key')
    } finally {
      if (original == null) delete process.env.KILOCODE_API_KEY
      else process.env.KILOCODE_API_KEY = original
    }
  })

  it('supports OpenAI-compatible provider env vars for key, base URL, and model', () => {
    const originalKey = process.env.OPENAI_COMPATIBLE_API_KEY
    const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const originalModel = process.env.OPENAI_COMPATIBLE_MODEL

    try {
      delete process.env.OPENAI_COMPATIBLE_API_KEY
      delete process.env.OPENAI_COMPATIBLE_BASE_URL
      delete process.env.OPENAI_COMPATIBLE_MODEL

      const config = {
        apiKeys: { 'openai-compatible': 'config-key' },
        providers: { 'openai-compatible': { baseUrl: 'https://example.test/v1', modelId: 'foo/bar' } },
      }

      assert.equal(getApiKey(config, 'openai-compatible'), 'config-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible'), 'https://example.test/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible'), 'foo/bar')

      process.env.OPENAI_COMPATIBLE_API_KEY = 'env-key'
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://env.example/v1'
      process.env.OPENAI_COMPATIBLE_MODEL = 'env/model'

      assert.equal(getApiKey(config, 'openai-compatible'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible'), 'https://env.example/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible'), 'env/model')
    } finally {
      if (originalKey == null) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = originalKey

      if (originalBaseUrl == null) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBaseUrl

      if (originalModel == null) delete process.env.OPENAI_COMPATIBLE_MODEL
      else process.env.OPENAI_COMPATIBLE_MODEL = originalModel
    }
  })

  it('supports Ollama provider env vars for key, base URL, and model', () => {
    const originalKey = process.env.OLLAMA_API_KEY
    const originalBaseUrl = process.env.OLLAMA_BASE_URL
    const originalModel = process.env.OLLAMA_MODEL

    try {
      delete process.env.OLLAMA_API_KEY
      delete process.env.OLLAMA_BASE_URL
      delete process.env.OLLAMA_MODEL

      const config = {
        apiKeys: { ollama: 'config-key' },
        providers: { ollama: { baseUrl: 'https://ollama.com/v1', modelId: 'gpt-oss:120b' } },
      }

      assert.equal(getApiKey(config, 'ollama'), 'config-key')
      assert.equal(getProviderBaseUrl(config, 'ollama'), 'https://ollama.com/v1')
      assert.equal(getProviderModelId(config, 'ollama'), 'gpt-oss:120b')

      process.env.OLLAMA_API_KEY = 'env-key'
      process.env.OLLAMA_BASE_URL = 'https://ollama.com/v1'
      process.env.OLLAMA_MODEL = 'llama3.3'

      assert.equal(getApiKey(config, 'ollama'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'ollama'), 'https://ollama.com/v1')
      assert.equal(getProviderModelId(config, 'ollama'), 'llama3.3')
    } finally {
      if (originalKey == null) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = originalKey

      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = originalBaseUrl

      if (originalModel == null) delete process.env.OLLAMA_MODEL
      else process.env.OLLAMA_MODEL = originalModel
    }
  })

  it('uses Ollama cloud base URL when none is configured', () => {
    const originalBaseUrl = process.env.OLLAMA_BASE_URL

    try {
      delete process.env.OLLAMA_BASE_URL
      assert.equal(getProviderBaseUrl({ providers: { ollama: {} } }, 'ollama'), null)
    } finally {
      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = originalBaseUrl
    }
  })

  it('supports OpenCode provider env var override', () => {
    const original = process.env.OPENCODE_API_KEY

    try {
      delete process.env.OPENCODE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'opencode'), null)

      process.env.OPENCODE_API_KEY = 'opencode-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'opencode'), 'opencode-env-key')
      assert.equal(getApiKey({ apiKeys: { opencode: 'file-key' } }, 'opencode'), 'opencode-env-key')
    } finally {
      if (original == null) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
    }
  })

  it('resolves Kiro OAuth refresh token from env and config', () => {
    const original = process.env.KIRO_REFRESH_TOKEN

    try {
      delete process.env.KIRO_REFRESH_TOKEN
      assert.equal(getKiroRefreshToken({ providers: {} }), null)
      assert.equal(getKiroRefreshToken({ providers: { kiro: { refreshToken: 'config-refresh-token' } } }), 'config-refresh-token')

      process.env.KIRO_REFRESH_TOKEN = 'env-refresh-token'
      assert.equal(getKiroRefreshToken({ providers: { kiro: { refreshToken: 'config-refresh-token' } } }), 'env-refresh-token')
    } finally {
      if (original === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = original
    }
  })

  it('reports Kiro auth configured when OAuth refresh token is present', () => {
    assert.equal(hasKiroAuthConfigured({ providers: {} }), false)
    assert.equal(hasKiroAuthConfigured({ providers: { kiro: { refreshToken: 'rtok' } } }), true)
  })

  it('refreshes Kiro OAuth access tokens from the Kiro refresh endpoint', async () => {
    const originalRefreshToken = process.env.KIRO_REFRESH_TOKEN
    const originalClientId = process.env.KIRO_OAUTH_CLIENT_ID
    const originalClientSecret = process.env.KIRO_OAUTH_CLIENT_SECRET
    const originalFetch = globalThis.fetch
    const refreshToken = 'aorAAAAAG-test-refresh-token'

    process.env.KIRO_REFRESH_TOKEN = refreshToken
    delete process.env.KIRO_OAUTH_CLIENT_ID
    delete process.env.KIRO_OAUTH_CLIENT_SECRET

    let callCount = 0
    globalThis.fetch = async (url, init) => {
      callCount += 1
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.headers?.['Content-Type'], 'application/json')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.refreshToken, refreshToken)
      return new Response(JSON.stringify({
        accessToken: 'oauth-access-token',
        refreshToken,
        expiresIn: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenA = await resolveKiroOAuthAccessToken({ providers: {} })
      const tokenB = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenA, 'oauth-access-token')
      assert.equal(tokenB, 'oauth-access-token')
      assert.equal(callCount, 1)
    } finally {
      globalThis.fetch = originalFetch
      if (originalRefreshToken === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = originalRefreshToken
      if (originalClientId === undefined) delete process.env.KIRO_OAUTH_CLIENT_ID
      else process.env.KIRO_OAUTH_CLIENT_ID = originalClientId
      if (originalClientSecret === undefined) delete process.env.KIRO_OAUTH_CLIENT_SECRET
      else process.env.KIRO_OAUTH_CLIENT_SECRET = originalClientSecret
    }
  })

  it('uses rotated refresh token for subsequent cache-miss refreshes', async () => {
    const originalRefreshToken = process.env.KIRO_REFRESH_TOKEN
    const originalClientId = process.env.KIRO_OAUTH_CLIENT_ID
    const originalClientSecret = process.env.KIRO_OAUTH_CLIENT_SECRET
    const originalFetch = globalThis.fetch
    const initialToken = 'aorAAAAAG-initial-refresh-token'
    const rotatedToken = 'aorAAAAAG-rotated-refresh-token'

    process.env.KIRO_REFRESH_TOKEN = initialToken
    delete process.env.KIRO_OAUTH_CLIENT_ID
    delete process.env.KIRO_OAUTH_CLIENT_SECRET

    let callCount = 0
    const tokensReceived = []
    // expiresIn: 1 puts the expiry inside the 60-second skew window so the cache immediately misses on the next call
    globalThis.fetch = async (url, init) => {
      callCount += 1
      const body = JSON.parse(String(init?.body || '{}'))
      tokensReceived.push(body.refreshToken)
      return new Response(JSON.stringify({
        accessToken: `oauth-access-token-${callCount}`,
        refreshToken: rotatedToken,
        expiresIn: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      // First call: cache miss → fetch with initialToken → response includes rotatedToken
      const tokenA = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenA, 'oauth-access-token-1')
      assert.equal(tokensReceived[0], initialToken)
      assert.equal(callCount, 1)

      // Second call: cache is expired (expiresIn:1 < skew), but sourceRefreshToken matches
      // so effectiveRefreshToken should be the rotated token, not the original
      const tokenB = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenB, 'oauth-access-token-2')
      assert.equal(tokensReceived[1], rotatedToken)
      assert.equal(callCount, 2)
    } finally {
      globalThis.fetch = originalFetch
      if (originalRefreshToken === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = originalRefreshToken
      if (originalClientId === undefined) delete process.env.KIRO_OAUTH_CLIENT_ID
      else process.env.KIRO_OAUTH_CLIENT_ID = originalClientId
      if (originalClientSecret === undefined) delete process.env.KIRO_OAUTH_CLIENT_SECRET
      else process.env.KIRO_OAUTH_CLIENT_SECRET = originalClientSecret
    }
  })

  it('builds Kiro browser OAuth URLs for Google and GitHub', () => {
    const googleUrl = new URL(buildKiroSocialLoginUrl('google', 'challenge-google', 'state-google'))
    assert.equal(`${googleUrl.origin}${googleUrl.pathname}`, 'https://prod.us-east-1.auth.desktop.kiro.dev/login')
    assert.equal(googleUrl.searchParams.get('idp'), 'Google')
    assert.equal(googleUrl.searchParams.get('code_challenge'), 'challenge-google')
    assert.equal(googleUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(googleUrl.searchParams.get('state'), 'state-google')
    assert.equal(googleUrl.searchParams.get('redirect_uri'), 'kiro://kiro.kiroAgent/authenticate-success')

    const githubUrl = new URL(buildKiroSocialLoginUrl('github', 'challenge-github', 'state-github'))
    assert.equal(githubUrl.searchParams.get('idp'), 'Github')
  })

  it('exchanges Kiro browser OAuth codes for tokens', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.headers?.['Content-Type'], 'application/json')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.code, 'browser-code')
      assert.equal(body.code_verifier, 'browser-verifier')
      assert.equal(body.redirect_uri, 'kiro://kiro.kiroAgent/authenticate-success')
      return new Response(JSON.stringify({
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-browser-refresh',
        profileArn: 'arn:aws:builder-profile',
        expiresIn: 1800,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenData = await exchangeKiroSocialCode('browser-code', 'browser-verifier')
      assert.deepEqual(tokenData, {
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-browser-refresh',
        profileArn: 'arn:aws:builder-profile',
        expiresIn: 1800,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps Kiro browser OAuth PKCE verifier server-side during exchange', async () => {
    const flow = startKiroSocialAuthFlow('google')
    assert.match(flow.flowId, /^[0-9a-f-]{36}$/)
    assert.equal(flow.codeVerifier, undefined)
    assert.equal(flow.authUrl.includes('code_challenge='), true)
    const state = new URL(flow.authUrl).searchParams.get('state')

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.code, 'browser-code')
      assert.match(body.code_verifier, /^[A-Fa-f0-9]{64}$/)
      assert.notEqual(body.code_verifier, 'attacker-controlled-verifier')
      return new Response(JSON.stringify({
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-flow-refresh',
        expiresIn: 1800,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenData = await exchangeKiroSocialAuthFlow(flow.flowId, 'browser-code', state)
      assert.equal(tokenData.refreshToken, 'aorAAAAAG-flow-refresh')
      await assert.rejects(
        () => exchangeKiroSocialAuthFlow(flow.flowId, 'browser-code', state),
        /Unknown or expired Kiro browser OAuth flow/
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('extracts Kiro auth email from JWT access tokens when present', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'kiro@example.com' }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const token = `header.${payload}.signature`
    assert.equal(extractKiroEmailFromAccessToken(token), 'kiro@example.com')
    assert.equal(extractKiroEmailFromAccessToken('not-a-jwt'), null)
  })

  it('starts Kiro AWS Builder ID device authorization', async () => {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url) === 'https://oidc.us-east-1.amazonaws.com/client/register') {
        return new Response(JSON.stringify({
          clientId: 'builder-client-id',
          clientSecret: 'builder-client-secret',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (String(url) === 'https://oidc.us-east-1.amazonaws.com/device_authorization') {
        const body = JSON.parse(String(init?.body || '{}'))
        assert.equal(body.clientId, 'builder-client-id')
        assert.equal(body.clientSecret, 'builder-client-secret')
        assert.equal(body.startUrl, 'https://view.awsapps.com/start')
        return new Response(JSON.stringify({
          deviceCode: 'device-code-123',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://device.sso.aws/verify',
          verificationUriComplete: 'https://device.sso.aws/verify?user_code=ABCD-EFGH',
          expiresIn: 600,
          interval: 5,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }

    try {
      const auth = await startKiroBuilderIdDeviceAuth()
      assert.deepEqual(auth, {
        clientId: 'builder-client-id',
        clientSecret: 'builder-client-secret',
        deviceCode: 'device-code-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://device.sso.aws/verify',
        verificationUriComplete: 'https://device.sso.aws/verify?user_code=ABCD-EFGH',
        expiresIn: 600,
        interval: 5,
      })
      assert.equal(calls.length, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('polls Kiro AWS Builder ID tokens and surfaces pending status', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'authorization_pending',
      error_description: 'Still waiting for approval',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })

    try {
      const pending = await pollKiroBuilderIdToken('device-code-123', 'builder-client-id', 'builder-client-secret')
      assert.deepEqual(pending, {
        success: false,
        pending: true,
        error: 'authorization_pending',
        errorDescription: 'Still waiting for approval',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('polls Kiro AWS Builder ID tokens and returns refresh credentials on success', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://oidc.us-east-1.amazonaws.com/token')
      assert.equal(init?.method, 'POST')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.clientId, 'builder-client-id')
      assert.equal(body.clientSecret, 'builder-client-secret')
      assert.equal(body.deviceCode, 'device-code-123')
      assert.equal(body.grantType, 'urn:ietf:params:oauth:grant-type:device_code')
      return new Response(JSON.stringify({
        accessToken: 'builder-access-token',
        refreshToken: 'aorAAAAAG-builder-refresh',
        expiresIn: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const result = await pollKiroBuilderIdToken('device-code-123', 'builder-client-id', 'builder-client-secret')
      assert.deepEqual(result, {
        success: true,
        tokens: {
          accessToken: 'builder-access-token',
          refreshToken: 'aorAAAAAG-builder-refresh',
          expiresIn: 3600,
          clientId: 'builder-client-id',
          clientSecret: 'builder-client-secret',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('treats OpenCode and KiloCode auth as optional bearer auth providers, and local Ollama as optional', () => {
    assert.equal(isProviderAuthOptional({}, 'opencode'), true)
    assert.equal(isProviderAuthOptional({}, 'kilocode'), true)
    assert.equal(isProviderAuthOptional({}, 'ollama'), false)
    assert.equal(isProviderAuthOptional({ providers: { ollama: { baseUrl: 'http://127.0.0.1:11434' } } }, 'ollama'), true)
    assert.equal(isProviderAuthOptional({ providers: { ollama: { baseUrl: 'http://localhost:11434' } } }, 'ollama'), true)
    assert.equal(isProviderAuthOptional({}, 'openrouter'), false)

    assert.equal(isProviderBearerAuthEnabled({}, 'opencode'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'kilocode'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'ollama'), true)
    assert.equal(isProviderBearerAuthEnabled({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(isProviderBearerAuthEnabled({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)
    assert.equal(isProviderBearerAuthEnabled({ providers: { ollama: { useBearerAuth: false } } }, 'ollama'), true)

    assert.equal(providerWantsBearerAuth({}, 'opencode'), true)
    assert.equal(providerWantsBearerAuth({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(providerWantsBearerAuth({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)
    assert.equal(providerWantsBearerAuth({ providers: { ollama: { useBearerAuth: false } } }, 'ollama'), true)
    assert.equal(providerWantsBearerAuth({}, 'openrouter'), true)
  })

  it('builds stable OpenCode CLI headers for unauthenticated requests', () => {
    assert.equal(buildOpencodeProjectId('C:/example/project'), buildOpencodeProjectId('C:/example/project'))
    assert.match(buildOpencodeProjectId('C:/example/project'), /^[a-f0-9]{40}$/)

    const headers = buildOpencodeHeaders({
      projectSeed: 'C:/example/project',
      sessionId: 'ses_test',
      requestId: 'req_test',
    })

    assert.deepEqual(headers, {
      'x-opencode-project': buildOpencodeProjectId('C:/example/project'),
      'x-opencode-session': 'ses_test',
      'x-opencode-request': 'req_test',
      'x-opencode-client': 'cli',
    })
  })

  it('adds OpenCode CLI headers to provider requests without requiring a bearer token', () => {
    const headers = buildProviderRequestHeaders('opencode', {
      projectSeed: 'C:/example/project',
      sessionId: 'ses_test',
      requestId: 'req_test',
    })

    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Authorization, undefined)
    assert.equal(headers['x-opencode-project'], buildOpencodeProjectId('C:/example/project'))
    assert.equal(headers['x-opencode-session'], 'ses_test')
    assert.equal(headers['x-opencode-request'], 'req_test')
    assert.equal(headers['x-opencode-client'], 'cli')
  })

  it('leaves the OpenCode request untouched by default', () => {
    // The free-tier compatibility is opt-in. Without it the request must look
    // exactly like it did before: no User-Agent, no injected tool, no forced
    // stream, and the original session id format.
    const headers = buildProviderRequestHeaders('opencode', { projectSeed: 'C:/example/project' })
    assert.equal(headers['User-Agent'], undefined)
    assert.match(headers['x-opencode-session'], /^ses_[0-9a-f]{32}$/)

    const body = { model: 'nemotron-3.5-super-vl-free', messages: [{ role: 'user', content: 'Hi' }] }
    const out = buildProviderRequestBody('opencode', body, 'nemotron-3.5-super-vl-free')
    assert.equal(out, body)
    assert.equal(out.stream, undefined)
    assert.equal(out.tools, undefined)
  })

  it('reads the OpenCode free-tier compatibility flag from the config and the env var', () => {
    // This fork ships with the mode on by default.
    assert.equal(isOpencodeFreeTierCompatEnabled({}), true)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: true }), true)
    // An explicit false still turns it off.
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: false }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: '0' }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: 'off' }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: '1' }), true)
    // A typo must not silently enable the request rewriting.
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: 'yes please' }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: 1 }), false)

    process.env.MODELRELAY_OPENCODE_FREE_COMPAT = '1'
    try {
      // The env var wins over the config file.
      assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: false }), true)
    } finally {
      delete process.env.MODELRELAY_OPENCODE_FREE_COMPAT
    }
  })

  it('lets the OpenCode User-Agent be overridden', () => {
    process.env.MODELRELAY_OPENCODE_FREE_TIER_USER_AGENT = 'opencode/9.9.9'
    try {
      assert.equal(getOpencodeFreeTierUserAgent({}), 'opencode/9.9.9')
    } finally {
      delete process.env.MODELRELAY_OPENCODE_FREE_TIER_USER_AGENT
    }
    assert.equal(getOpencodeFreeTierUserAgent({ opencodeFreeTierUserAgent: 'opencode/1.2.3' }), 'opencode/1.2.3')
    assert.equal(getOpencodeFreeTierUserAgent({}), DEFAULT_OPENCODE_USER_AGENT)
  })

  it('sends the OpenCode free-tier headers only when the compatibility mode is on', () => {
    // This fork ships with the mode on by default.
    const defaultOptions = buildOpencodeCompatOptions('opencode', {})
    assert.equal(defaultOptions.freeTierCompat, true)
    const byDefault = buildProviderRequestHeaders('opencode', defaultOptions)
    assert.equal(byDefault['User-Agent'], DEFAULT_OPENCODE_USER_AGENT)
    assert.match(byDefault['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

    // Off: no User-Agent and the old session id format.
    const offOptions = buildOpencodeCompatOptions('opencode', { opencodeFreeTierCompat: false })
    assert.equal(offOptions.freeTierCompat, false)
    const off = buildProviderRequestHeaders('opencode', offOptions)
    assert.equal(off['User-Agent'], undefined)
    assert.match(off['x-opencode-session'], /^ses_[0-9a-f]{32}$/)

    // On: a matching User-Agent and the session id format the endpoint expects.
    const onOptions = buildOpencodeCompatOptions('opencode', { opencodeFreeTierCompat: true })
    assert.equal(onOptions.freeTierCompat, true)
    const on = buildProviderRequestHeaders('opencode', onOptions)
    assert.equal(on['User-Agent'], DEFAULT_OPENCODE_USER_AGENT)
    assert.match(on['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

    // The User-Agent stays overridable.
    const custom = buildOpencodeCompatOptions('opencode', {
      opencodeFreeTierCompat: true,
      opencodeFreeTierUserAgent: 'opencode/1.2.3',
    })
    assert.equal(buildProviderRequestHeaders('opencode', custom)['User-Agent'], 'opencode/1.2.3')

    // Another provider is unaffected.
    const other = buildOpencodeCompatOptions('nvidia', { opencodeFreeTierCompat: true })
    assert.equal(other.freeTierCompat, false)
  })

  it('enables the OpenCode free-tier mode by default in this fork, and lets it be turned off', () => {
    // Unset -> the fork default, which is on.
    assert.equal(isOpencodeFreeTierCompatEnabled({}), true)
    assert.equal(isOpencodeFreeTierCompatEnabled(undefined), true)

    // An explicit value always wins over the default.
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: true }), true)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: false }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: '0' }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: 'off' }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: 'no' }), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: '1' }), true)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: 'yes' }), true)

    // The env var wins over the config, in both directions.
    process.env.MODELRELAY_OPENCODE_FREE_COMPAT = '0'
    assert.equal(isOpencodeFreeTierCompatEnabled({}), false)
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: true }), false)
    process.env.MODELRELAY_OPENCODE_FREE_COMPAT = '1'
    assert.equal(isOpencodeFreeTierCompatEnabled({ opencodeFreeTierCompat: false }), true)
    delete process.env.MODELRELAY_OPENCODE_FREE_COMPAT
  })

  it('keeps an unset compatibility flag unset when the config is normalized', () => {
    // The default must survive a config round trip, so normalization may not
    // turn "unset" into an explicit false.
    const normalized = normalizeConfigShape({ apiKeys: {} })
    assert.equal(normalized.opencodeFreeTierCompat, undefined)

    // An explicit value is still normalized to a boolean.
    assert.equal(normalizeConfigShape({ apiKeys: {}, opencodeFreeTierCompat: 'yes' }).opencodeFreeTierCompat, true)
    assert.equal(normalizeConfigShape({ apiKeys: {}, opencodeFreeTierCompat: 'nope' }).opencodeFreeTierCompat, false)
  })

  it('retries the transient request states as well as the rate limit', () => {
    assert.equal(isRetryableProxyStatus(429), true)
    assert.equal(isRetryableProxyStatus(410), true)
    assert.equal(isRetryableProxyStatus(408), true)
    assert.equal(isRetryableProxyStatus(421), true)
    assert.equal(isRetryableProxyStatus(425), true)
    assert.equal(isRetryableProxyStatus(500), true)
    assert.equal(isRetryableProxyStatus(503), true)
    // A client error that is not transient is not retried.
    assert.equal(isRetryableProxyStatus(400), false)
    assert.equal(isRetryableProxyStatus(401), false)
    assert.equal(isRetryableProxyStatus(404), false)
  })

  it('classifies model-scoped errors so the router moves on to another model', () => {
    // 404 is always model-scoped: the provider does not have that model.
    assert.equal(isModelScopedError(404, ''), true)
    assert.equal(isModelScopedError(404, null), true)

    // A 400 that names a model problem is model-scoped, by error code...
    assert.equal(isModelScopedError(400, JSON.stringify({ error: { code: 'model_not_found' } })), true)
    assert.equal(isModelScopedError(400, JSON.stringify({ error: { code: 'context_length_exceeded' } })), true)
    assert.equal(isModelScopedError(422, JSON.stringify({ error: { type: 'model_not_supported' } })), true)
    // ...and by the way providers phrase it.
    assert.equal(isModelScopedError(400, 'The model `foo` does not exist'), true)
    assert.equal(isModelScopedError(400, "This model's maximum context length is 8192 tokens"), true)
    assert.equal(isModelScopedError(400, 'tool_choice is not supported by this model'), true)

    // 413: the request does not fit the model's limit. Another model with a bigger window
    // can serve it, so the router moves on. Seen live: "Request too large for model ...".
    assert.equal(isModelScopedError(413, ''), true)
    assert.equal(isModelScopedError(413, 'Request too large for model `qwen/qwen3.8-27b`'), true)

    // A 403 that names the model is about the model, not about the account.
    assert.equal(isModelScopedError(403, 'You do not have access to this model'), true)
    assert.equal(isModelScopedError(403, 'model `x` not available for your tier'), true)

    // A malformed request fails on every model -- retrying it would only delay the error.
    assert.equal(isModelScopedError(400, JSON.stringify({ error: { code: 'invalid_request_error', message: 'messages is required' } })), false)
    assert.equal(isModelScopedError(400, 'invalid api key'), false)
    assert.equal(isModelScopedError(422, 'unprocessable entity'), false)
    assert.equal(isModelScopedError(401, 'unauthorized'), false)
    assert.equal(isModelScopedError(403, 'forbidden'), false)
    assert.equal(isModelScopedError(403, 'invalid api key'), false)
    assert.equal(isModelScopedError(500, 'server error'), false)
  })

  it('ranks a model without benchmark data as unknown instead of as the worst', () => {
    const rated = { modelId: 'rated', providerKey: 'p', status: 'up', intell: 0.68, avg: 300, pings: [{ ms: 300, code: '200' }] }
    const unrated = { modelId: 'unrated', providerKey: 'p', status: 'up', intell: 0, avg: 300, pings: [{ ms: 300, code: '200' }] }

    // Without a floor the unrated model loses every comparison on quality alone.
    const withoutFloor = computeQoSMap([rated, unrated], [], { unratedQualityFloor: 0 })
    assert.ok(withoutFloor.get(rated) > withoutFloor.get(unrated) * 10)

    // With a floor it competes on speed and uptime instead of being excluded by default.
    const withFloor = computeQoSMap([rated, unrated], [], { unratedQualityFloor: 35 })
    assert.ok(withFloor.get(unrated) > 0)
    assert.ok(withFloor.get(unrated) > withoutFloor.get(unrated))

    // The floor only applies to models that have no score at all.
    const ratedWithFloor = computeQoSMap([rated], [], { unratedQualityFloor: 35 })
    const ratedWithoutFloor = computeQoSMap([rated], [], { unratedQualityFloor: 0 })
    assert.equal(ratedWithFloor.get(rated), ratedWithoutFloor.get(rated))
  })

  it('keeps the model-scoped failover and the failure reason wired into the request path', () => {
    // Both live in the request handler, which is only reachable with a running router, so the
    // wiring is asserted on the source instead of exercised end to end.
    const source = readFileSync(join(ROOT, 'lib', 'server.js'), 'utf8')

    // A model-scoped error has to reach the retry decision, not just exist as a helper.
    assert.match(source, /isModelScopedError\(response\.status, rateLimitBodyText\)/)
    assert.match(source, /\|\| modelScopedError/)

    // The 503 has to name the reason the pool came up empty.
    assert.match(source, /No models currently available for this request\.\$\{reason\}/)
    assert.match(source, /last attempt: /)
  })

  it('keeps the retry budget wired to the config instead of a hardcoded constant', () => {
    // The unit tests above cover the getter; this one covers the wiring. Without it, the
    // router could fall back to a fixed budget and every test would still pass while the
    // config setting silently did nothing.
    const source = readFileSync(join(ROOT, 'lib', 'server.js'), 'utf8')
    assert.match(source, /getMaxProactiveRetries\(loadConfig\(\)\)/)
    // The constant may only survive as the fallback default in config.js, not as the
    // value the retry loop actually uses.
    const usesConstant = /MAX_PROACTIVE_RETRIES/.test(source)
    assert.equal(usesConstant, false)
  })

  it('reads the retry budget and the quality floor from the config', () => {
    assert.equal(getMaxProactiveRetries({}), 12)
    assert.equal(getMaxProactiveRetries({ maxProactiveRetries: 4 }), 4)
    assert.equal(getMaxProactiveRetries({ maxProactiveRetries: 0 }), 1)
    assert.equal(getMaxProactiveRetries({ maxProactiveRetries: 999 }), 50)
    assert.equal(getMaxProactiveRetries({ maxProactiveRetries: 'nonsense' }), 12)

    assert.equal(getQosUnratedQualityFloor({}), 35)
    assert.equal(getQosUnratedQualityFloor({ qosUnratedQualityFloor: 0 }), 0)
    assert.equal(getQosUnratedQualityFloor({ qosUnratedQualityFloor: 60 }), 60)
    assert.equal(getQosUnratedQualityFloor({ qosUnratedQualityFloor: -5 }), 0)
    assert.equal(getQosUnratedQualityFloor({ qosUnratedQualityFloor: 500 }), 100)
  })

  it('rewrites the OpenCode body into the free-tier shape when the compatibility mode is on', () => {
    const payload = buildOpencodeFreeTierPayload({
      model: 'nemotron-3.5-super-vl-free',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    assert.equal(payload.stream, true)
    assert.ok(payload.tools.some((tool) => tool.function.name === 'read'))
    assert.equal(payload.messages[0].role, 'system')
    assert.equal(payload.messages[0].content, 'You are opencode')
  })

  it('keeps a caller-supplied read tool and system message', () => {
    const payload = buildOpencodeFreeTierPayload({
      model: 'nemotron-3.5-super-vl-free',
      messages: [{ role: 'system', content: 'You are opencode' }, { role: 'user', content: 'Hello' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    })

    assert.equal(payload.tools.length, 1)
    assert.equal(payload.messages.length, 2)
  })

  it('sends the free-tier shape in the OpenCode health check', () => {
    // The ping has to use the same request as a real request. If it did not,
    // the health check would report the free models as `down` with a 403 even
    // though the proxy could route them.
    const on = buildPingRequest('opencode', 'nemotron-3.5-super-vl-free', null, { opencodeFreeTierCompat: true })
    assert.equal(on.headers['User-Agent'], DEFAULT_OPENCODE_USER_AGENT)
    assert.match(on.headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.equal(on.payload.stream, true)
    assert.ok(on.payload.tools.some((tool) => tool.function.name === 'read'))

    // Another provider is unaffected.
    const other = buildPingRequest('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'key', { opencodeFreeTierCompat: true })
    assert.equal(other.headers['User-Agent'], undefined)
    assert.equal(other.payload.stream, undefined)
    assert.equal(other.payload.tools, undefined)
  })

  it('routes the OpenCode provider body through the free-tier shape only when opted in', () => {
    const body = { model: 'nemotron-3.5-super-vl-free', messages: [{ role: 'user', content: 'Hi' }] }

    // Opted out: the body is passed through unchanged.
    const off = buildProviderRequestBody('opencode', body, 'nemotron-3.5-super-vl-free', { freeTierCompat: false })
    assert.equal(off, body)

    // Opted in: the body carries the free-tier shape.
    const on = buildProviderRequestBody('opencode', body, 'nemotron-3.5-super-vl-free', { freeTierCompat: true })
    assert.equal(on.stream, true)
    assert.ok(on.tools.some((tool) => tool.function.name === 'read'))
    assert.equal(on.messages[0].content, 'You are opencode')
  })

  it('marks the OpenCode Zen free models as unsupported instead of down', () => {
    // Without the compatibility mode the free models are not usable, but they
    // are not broken either. They must not show up as `down`, and they must
    // not be routed to.
    assert.equal(isModelEligibleForRouting({ status: 'unsupported' }), false)
    assert.equal(isModelEligibleForRouting({ status: 'down' }), true)

    // The free models of the OpenCode provider are the affected ones. With the
    // compatibility mode off they are not usable, but they are not broken
    // either, so they must not be routed to.
    assert.equal(isOpencodeFreeModelUnsupported('opencode', 'nemotron-3.5-super-vl-free', { opencodeFreeTierCompat: false }), true)
    assert.equal(isOpencodeFreeModelUnsupported('opencode', 'beam-free', { opencodeFreeTierCompat: false }), true)
    // With the compatibility mode on they are usable. This fork has it on by
    // default, so an unset config is enough.
    assert.equal(isOpencodeFreeModelUnsupported('opencode', 'nemotron-3.5-super-vl-free', { opencodeFreeTierCompat: true }), false)
    assert.equal(isOpencodeFreeModelUnsupported('opencode', 'nemotron-3.5-super-vl-free', {}), false)
    // Other providers and other models are unaffected.
    assert.equal(isOpencodeFreeModelUnsupported('nvidia', 'nemotron-3.5-super-vl-free', {}), false)
    assert.equal(isOpencodeFreeModelUnsupported('opencode', 'some-paid-model', {}), false)
  })

  it('strips calls to the injected read tool from a response', () => {
    const data = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }

    stripInjectedToolCalls(data, false)
    assert.equal(data.choices[0].message.tool_calls, undefined)
    assert.equal(data.choices[0].finish_reason, 'stop')
  })

  it('keeps calls to the injected read tool when the caller declared it', () => {
    const data = {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
      }],
    }

    stripInjectedToolCalls(data, true)
    assert.equal(data.choices[0].message.tool_calls.length, 1)
  })

  it('strips the injected read tool from a streamed response', () => {
    const chunk = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    const out = stripInjectedToolCallsFromSseChunk(chunk)

    assert.equal(out.includes('"name":"read"'), false)
    assert.ok(out.includes('"content":"hello"'))
  })

  it('converts an OpenCode SSE stream back into JSON for a non-streaming caller', () => {
    const sse = 'data: {"model":"nemotron-3.5-super-vl-free","choices":[{"delta":{"content":"PONG"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n'

    const json = collectOpencodeStreamAsJson(sse, 'nemotron-3.5-super-vl-free')
    assert.equal(json.object, 'chat.completion')
    assert.equal(json.choices[0].message.content, 'PONG')
    assert.equal(json.choices[0].finish_reason, 'stop')
  })

  it('converts a streamed read tool call into JSON and strips it', () => {
    const sse = 'data: {"model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read","arguments":"{\"filePath\":\"a\"}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'

    const json = collectOpencodeStreamAsJson(sse, 'm')
    stripInjectedToolCalls(json, false)
    assert.equal(json.choices[0].message.tool_calls, undefined)
    assert.equal(json.choices[0].finish_reason, 'stop')
  })

  describe('OpenCode free-tier compatibility: non-streaming caller', () => {
    // The upstream only answers a streaming request, so the compatibility mode
    // has to hand a non-streaming caller a JSON body. This exercises that path
    // end to end over HTTP, not just the outgoing body.
    let server, port

    const post = (path, body) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      })
      req.on('error', reject)
      req.write(payload)
      req.end()
    })

    before(async () => {
      const app = express()
      app.post('/v1/chat/completions', async (req, res) => {
        const body = req.body || {}
        // The upstream always answers with SSE, like the real Zen endpoint does.
        const sse = 'data: {"model":"nemotron-3.5-super-vl-free","choices":[{"delta":{"content":"PONG"}}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n'
        // A caller that asked for stream: false gets the stream converted back
        // into a single JSON body.
        if (!body.stream) {
          const json = collectOpencodeStreamAsJson(sse, body.model)
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(json))
          return
        }
        res.setHeader('content-type', 'text/event-stream')
        res.end(sse)
      })
      await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
      port = server.address().port
    })
    after(() => new Promise(resolve => server.close(resolve)))

    it('returns a JSON body to a caller that asked for stream: false', async () => {
      const res = await post('/v1/chat/completions', {
        model: 'nemotron-3.5-super-vl-free',
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        stream: false,
      })

      assert.equal(res.status, 200)
      const json = JSON.parse(res.body)
      assert.equal(json.object, 'chat.completion')
      assert.equal(json.choices[0].message.content, 'PONG')
      assert.equal(json.choices[0].finish_reason, 'stop')
    })
  })

  it('adds Kiro SDK headers to provider requests', () => {
    const headers = buildProviderRequestHeaders('kiro', {
      apiKey: 'kiro-key',
    })

    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Accept, 'application/vnd.amazon.eventstream')
    assert.equal(headers.Authorization, 'Bearer kiro-key')
    assert.equal(headers['X-Amz-Target'], 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse')
    assert.equal(headers['User-Agent'], 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0')
    assert.equal(headers['X-Amz-User-Agent'], 'aws-sdk-js/3.0.0 kiro-ide/1.0.0')
  })

  it('translates OpenAI chat payloads into Kiro conversation state', () => {
    const payload = buildKiroRequestPayload({
      messages: [
        { role: 'system', content: 'Keep it short.' },
        { role: 'user', content: 'Say hi.' },
      ],
      max_tokens: 32,
      temperature: 0.4,
    }, 'claude-haiku-4.5')

    assert.equal(payload.conversationState.chatTriggerType, 'MANUAL')
    assert.equal(payload.conversationState.currentMessage.userInputMessage.modelId, 'claude-haiku-4.5')
    assert.equal(payload.conversationState.currentMessage.userInputMessage.origin, 'AI_EDITOR')
    assert.match(payload.conversationState.currentMessage.userInputMessage.content, /\[Context: Current time is .*]\n\nSay hi\./)
    assert.equal(payload.conversationState.history.length, 1)
    assert.equal(payload.conversationState.history[0].userInputMessage.content, 'Keep it short.')
    assert.equal(payload.inferenceConfig.maxTokens, 32)
    assert.equal(payload.inferenceConfig.temperature, 0.4)
  })

  it('routes provider request body translation through Kiro only', () => {
    const kiroBody = buildProviderRequestBody('kiro', {
      model: 'claude-haiku-4.5',
      messages: [{ role: 'user', content: 'Hello there' }],
    }, 'claude-haiku-4.5')

    assert.ok(kiroBody.conversationState)
    assert.equal(kiroBody.model, undefined)

    const passthrough = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] }
    assert.equal(buildProviderRequestBody('openrouter', passthrough, 'gpt-4o-mini'), passthrough)
  })

  it('parses Kiro AWS EventStream frames', () => {
    const frame = encodeKiroEventFrame('assistantResponseEvent', { content: 'hello' })
    const parsed = parseKiroEventFrame(frame)

    assert.equal(parsed.headers[':event-type'], 'assistantResponseEvent')
    assert.equal(parsed.payload.content, 'hello')
  })

  it('transforms Kiro EventStream responses into OpenAI JSON responses', async () => {
    const bytes = Buffer.concat([
      Buffer.from(encodeKiroEventFrame('assistantResponseEvent', { content: 'Hello' })),
      Buffer.from(encodeKiroEventFrame('assistantResponseEvent', { content: ' there' })),
      Buffer.from(encodeKiroEventFrame('metricsEvent', { inputTokens: 11, outputTokens: 3 })),
      Buffer.from(encodeKiroEventFrame('messageStopEvent', {})),
    ])
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(transformed.headers.get('content-type'), 'application/json')
    assert.equal(data.choices[0].message.role, 'assistant')
    assert.equal(data.choices[0].message.content, 'Hello there')
    assert.equal(data.usage.prompt_tokens, 11)
    assert.equal(data.usage.completion_tokens, 3)
  })

  it('transforms Kiro EventStream exception frames into OpenAI error responses', async () => {
    const bytes = Buffer.from(encodeKiroFrame({
      ':message-type': 'exception',
      ':exception-type': 'ThrottlingException',
    }, { message: 'Rate exceeded' }))
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(transformed.status, 502)
    assert.equal(data.error.message, 'Rate exceeded')
    assert.equal(data.error.type, 'kiro_error')
    assert.equal(data.error.code, 'ThrottlingException')
  })

  it('assembles Kiro streaming tool call input.raw fragments into complete arguments', async () => {
    // Kiro sends toolUseEvent multiple times for the same toolId:
    // first with {toolUseId, name} announcing the tool, then with {toolUseId, input: {raw: "fragment"}}
    // carrying partial JSON fragments that must be concatenated.
    const toolId = 'tool-use-id-123'
    const bytes = Buffer.concat([
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, name: 'exec', input: null })),
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, input: { raw: '{"command"' } })),
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, input: { raw: ': "echo hi"}' } })),
      Buffer.from(encodeKiroEventFrame('metricsEvent', { inputTokens: 5, outputTokens: 2 })),
      Buffer.from(encodeKiroEventFrame('messageStopEvent', {})),
    ])
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(data.choices[0].finish_reason, 'tool_calls')
    assert.equal(data.choices[0].message.tool_calls.length, 1)
    const tc = data.choices[0].message.tool_calls[0]
    assert.equal(tc.id, toolId)
    assert.equal(tc.function.name, 'exec')
    assert.equal(tc.function.arguments, '{"command": "echo hi"}')
  })

  it('does not add Kiro SDK headers for non-Kiro providers', () => {
    const headers = buildProviderRequestHeaders('openrouter', {
      apiKey: 'openrouter-key',
    })

    assert.equal(headers['User-Agent'], undefined)
    assert.equal(headers['X-Amz-User-Agent'], undefined)
  })

  it('retries optional providers with bearer auth when an unauthenticated probe is rejected', () => {
    const config = {
      apiKeys: { opencode: 'opencode-key' },
      providers: { opencode: { useBearerAuth: false } },
    }

    assert.equal(
      shouldRetryOptionalProviderWithBearer(config, 'opencode', { token: null }, '401', 'Missing API key.'),
      true
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer(config, 'opencode', { token: null }, '401', 'Unauthorized'),
      true
    )
  })

  it('does not retry optional providers with bearer auth when there is no fallback key or a token was already used', () => {
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: {}, providers: { opencode: { useBearerAuth: false } } }, 'opencode', { token: null }, '401', 'Missing API key.'),
      false
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: { opencode: 'opencode-key' } }, 'opencode', { token: 'already-used' }, '401', 'Missing API key.'),
      false
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: { openrouter: 'openrouter-key' } }, 'openrouter', { token: null }, '401', 'Unauthorized'),
      false
    )
  })
})

describe('user-defined model tags', () => {
  it('normalizes and deduplicates tag input', () => {
    assert.equal(normalizeTag(' Code Review! '), 'code-review')
    assert.deepEqual(normalizeTags(['Fast', 'fast', 'agentic']), ['fast', 'agentic'])
  })

  it('stores tags under the canonical model id shared by providers', () => {
    const config = {}
    const updated = setModelTags(config, 'minimax-m2.5-free', ['Coding', 'agentic'])
    assert.equal(updated.key, 'minimax/minimax-m2.5')
    assert.deepEqual(getUserModelTags(config, 'minimax/minimax-m2.5:free'), ['coding', 'agentic'])
    assert.deepEqual(getConfiguredTagNames(config), ['agentic', 'coding'])
    assert.equal(getModelTagKey('minimax-m2.5-free'), 'minimax/minimax-m2.5')
  })

  it('clears persisted entries when the last tag is removed', () => {
    const config = { modelTags: { 'openai/gpt-oss-120b': ['general'] } }
    setModelTags(config, 'openai/gpt-oss-120b:free', [])
    assert.deepEqual(config.modelTags, {})
  })

  it('routes tag requests across all matching provider rows', () => {
    const results = [
      mockResult({ modelId: 'one', tags: ['coding'] }),
      mockResult({ modelId: 'two', tags: ['fast', 'coding'] }),
      mockResult({ modelId: 'three', tags: ['reasoning'] }),
    ]
    assert.deepEqual(filterModelsByRequested(results, 'tag:coding').map(model => model.modelId), ['one', 'two'])
    assert.deepEqual(filterModelsByRequested(results, 'tag:missing'), [])
    assert.deepEqual(filterModelsByRequested(results, 'tag:'), [])
  })

  it('filters tag requests by a min_ctx modifier', () => {
    const results = [
      mockResult({ modelId: 'small', tags: ['general'], ctx: '8k' }),
      mockResult({ modelId: 'medium', tags: ['general'], ctx: '32k' }),
      mockResult({ modelId: 'large', tags: ['general'], ctx: '1m' }),
      mockResult({ modelId: 'maximum-only', tags: ['general'], ctx: '1m', ctxSource: 'model-maximum' }),
      mockResult({ modelId: 'no-ctx', tags: ['general'], ctx: null }),
      mockResult({ modelId: 'wrong-tag', tags: ['coding'], ctx: '1m' }),
    ]

    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:32000').map(m => m.modelId),
      ['medium', 'large'],
    )
    // Exact boundary: a 32k model satisfies a 32000-token floor.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:32001').map(m => m.modelId),
      ['large'],
    )
    // Shorthand k/m suffixes on the modifier value itself.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:1m').map(m => m.modelId),
      ['large'],
    )
    // No modifier -- unchanged plain tag behavior, unparseable/missing ctx included.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general').map(m => m.modelId),
      ['small', 'medium', 'large', 'maximum-only', 'no-ctx'],
    )
  })

  it('caps min_ctx matching at a live-observed rate-limit token quota, not just the advertised context window', () => {
    const results = [
      // Reports a huge window, but the account's real per-minute quota (captured live from
      // provider rate-limit headers) is far below the requested floor -- must be excluded.
      mockResult({ modelId: 'quota-capped', tags: ['general'], ctx: '131k', ctxSource: 'provider-reported', rateLimit: { limitTokens: 8000 } }),
      // Quota is present but comfortably above the floor -- still eligible.
      mockResult({ modelId: 'quota-ample', tags: ['general'], ctx: '131k', ctxSource: 'provider-reported', rateLimit: { limitTokens: 64000 } }),
      // No rate-limit data captured yet -- falls back to the advertised window, unchanged.
      mockResult({ modelId: 'no-quota-data', tags: ['general'], ctx: '131k', ctxSource: 'provider-reported' }),
    ]

    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:32000').map(m => m.modelId),
      ['quota-ample', 'no-quota-data'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest+min_ctx:32000').map(m => m.modelId),
      ['quota-ample', 'no-quota-data'],
    )
  })

  it('keeps proxy quotas on the responding model when filtering later requests', async () => {
    const capped = mockResult({ providerKey: 'groq', modelId: 'quota-capped', tags: ['general'], ctx: '131k' })
    const ample = mockResult({ providerKey: 'groq', modelId: 'quota-ample', tags: ['general'], ctx: '131k' })
    const otherProvider = mockResult({ providerKey: 'other', modelId: 'quota-capped', tags: ['general'], ctx: '131k' })
    const results = [capped, ample, otherProvider]
    const response = (limit, status = 200) => new Response('{}', {
      status, headers: { 'x-ratelimit-limit-tokens': String(limit) },
    })
    const assertEligible = () => {
      for (const request of ['auto-fastest+min_ctx:32000', 'tag:general+min_ctx:32000']) {
        assert.deepEqual(filterModelsByRequested(results, request), [ample, otherProvider])
      }
    }

    await captureProxyRateLimit(results, ample, response(64000), 'test-key')
    await captureProxyRateLimit(results, capped, response(8000, 429), 'test-key')
    assert.equal(ample.rateLimit.limitTokens, 64000)
    assert.equal(ample.rateLimit.wasRateLimited, false)
    assert.equal(otherProvider.rateLimit, undefined)
    assertEligible()

    await captureProxyRateLimit(results, ample, response(64000), 'test-key')
    assert.equal(capped.rateLimit.limitTokens, 8000)
    assert.equal(capped.rateLimit.wasRateLimited, true)
    assertEligible()
  })

  it('shares OpenRouter key data while preserving each model response quota', async () => {
    const capped = mockResult({ providerKey: 'openrouter', modelId: 'quota-capped', rateLimit: { limitTokens: 8000 } })
    const ample = mockResult({ providerKey: 'openrouter', modelId: 'quota-ample' })
    const other = mockResult({ providerKey: 'groq' })
    const results = [capped, ample, other]
    await captureProxyRateLimit(results, ample, new Response('{}', {
      headers: { 'x-ratelimit-limit-tokens': '64000' },
    }), 'test-key', async () => ({ creditLimit: 10, creditRemaining: 9 }))

    assert.equal(capped.rateLimit.limitTokens, 8000)
    assert.equal(ample.rateLimit.limitTokens, 64000)
    assert.equal(capped.rateLimit.creditRemaining, 9)
    assert.equal(ample.rateLimit.creditRemaining, 9)
    assert.equal(other.rateLimit, undefined)
    assert.deepEqual(filterModelsByRequested(results, 'auto-fastest+min_ctx:32000'), [ample, other])
  })

  it('ignores unknown or malformed tag modifiers instead of rejecting the request', () => {
    const results = [mockResult({ modelId: 'one', tags: ['general'], ctx: '128k' })]
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+unknown_modifier:whatever').map(m => m.modelId),
      ['one'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:not-a-number').map(m => m.modelId),
      ['one'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+').map(m => m.modelId),
      ['one'],
    )
  })

  it('filters auto-fastest by min_ctx regardless of capability tags (issue #42)', () => {
    const results = [
      mockResult({ modelId: 'small', tags: ['general'], ctx: '8k' }),
      mockResult({ modelId: 'medium', tags: ['coding'], ctx: '128k' }),
      mockResult({ modelId: 'large', ctx: '1m' }), // no tags at all -- still eligible
    ]

    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest+min_ctx:128k').map(m => m.modelId),
      ['medium', 'large'],
    )
    // Plain auto-fastest is untouched -- still returns everything, unfiltered.
    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest').map(m => m.modelId),
      ['small', 'medium', 'large'],
    )
    // A malformed/unknown modifier falls back to plain auto-fastest behavior.
    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest+bogus:xyz').map(m => m.modelId),
      ['small', 'medium', 'large'],
    )
  })

  it('filters tag/auto-fastest requests by an exclude modifier', () => {
    const results = [
      mockResult({ modelId: 'qwen/qwen3.8-27b', providerKey: 'groq', tags: ['general'], ctx: '128k' }),
      mockResult({ modelId: 'qwen/qwen3.6-27b', providerKey: 'groq', tags: ['general'], ctx: '128k' }),
      mockResult({ modelId: 'llama-3.3-70b-versatile', providerKey: 'groq', tags: ['general'], ctx: '128k' }),
    ]

    // Bare modelId excludes across all providers.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+exclude:qwen/qwen3.8-27b').map(m => m.modelId),
      ['qwen/qwen3.6-27b', 'llama-3.3-70b-versatile'],
    )
    // Provider-qualified key excludes only that exact row.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+exclude:groq/qwen/qwen3.8-27b').map(m => m.modelId),
      ['qwen/qwen3.6-27b', 'llama-3.3-70b-versatile'],
    )
    // Multi-value via `|`.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+exclude:qwen/qwen3.8-27b|qwen/qwen3.6-27b').map(m => m.modelId),
      ['llama-3.3-70b-versatile'],
    )
    // Case-insensitive.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+exclude:GROQ/QWEN/QWEN3.8-27B').map(m => m.modelId),
      ['qwen/qwen3.6-27b', 'llama-3.3-70b-versatile'],
    )
    // Composes with min_ctx, order-independent.
    const withCtx = [
      mockResult({ modelId: 'small', providerKey: 'groq', tags: ['general'], ctx: '8k' }),
      mockResult({ modelId: 'medium', providerKey: 'groq', tags: ['general'], ctx: '128k' }),
      mockResult({ modelId: 'large', providerKey: 'groq', tags: ['general'], ctx: '128k' }),
    ]
    assert.deepEqual(
      filterModelsByRequested(withCtx, 'tag:general+min_ctx:32000+exclude:medium').map(m => m.modelId),
      ['large'],
    )
    assert.deepEqual(
      filterModelsByRequested(withCtx, 'tag:general+exclude:medium+min_ctx:32000').map(m => m.modelId),
      ['large'],
    )
    // Works for auto-fastest too, with no tag restriction.
    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest+exclude:qwen/qwen3.8-27b').map(m => m.modelId),
      ['qwen/qwen3.6-27b', 'llama-3.3-70b-versatile'],
    )
    // Empty or unmatched exclude values are silently ignored, not an error.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+exclude:').map(m => m.modelId),
      ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'llama-3.3-70b-versatile'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+exclude:nonexistent-id').map(m => m.modelId),
      ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'llama-3.3-70b-versatile'],
    )
  })

  it('normalizes persisted model tags safely', () => {
    const normalized = normalizeConfigShape({
      modelTags: {
        ' Model/One ': [' Fast ', 'fast', 'Code Review!', null],
        broken: 'not-an-array',
      },
    })
    assert.deepEqual(normalized.modelTags, { 'model/one': ['fast', 'code-review'] })
  })
})

describe('OpenRouter model quality scoring', () => {
  const catalog = [
    {
      id: 'vendor/direct-model',
      created: 1_750_000_000,
      context_length: 131072,
      supported_parameters: ['reasoning', 'tools', 'structured_outputs'],
      benchmarks: {
        artificial_analysis: { coding_index: 72 },
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1300 }],
      },
    },
    {
      id: 'vendor/training-model',
      benchmarks: {
        artificial_analysis: { coding_index: 52 },
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1100 }],
      },
    },
    {
      id: 'vendor/arena-only:free',
      benchmarks: {
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1200 }],
      },
    },
    {
      id: 'vendor/metadata-only:free',
      created: 1_750_000_000,
      context_length: 262144,
      supported_parameters: ['reasoning', 'tools'],
    },
  ]

  it('normalizes provider and runtime variants for cross-catalog matching', () => {
    assert.ok(qualityLookupKeys('deepseek-v4-flash:0731').includes('deepseek-v4-flash-0731'))
    assert.ok(qualityLookupKeys('inclusionai/ling-3.0-flash:free').includes('ling-3.0-flash'))
  })

  it('fits a deterministic linear regression for Design Arena conversion', () => {
    assert.deepEqual(fitLinearRegression([[1000, 40], [1200, 60]]), {
      slope: 0.1,
      intercept: -60,
      sampleSize: 2,
    })
  })

  it('uses coding index, Design Arena, then metadata in that order', () => {
    const quality = buildOpenRouterQualityIndex(catalog, [...catalog].reverse(), 1_760_000_000_000)
    const direct = resolveModelQuality(quality, 'vendor/direct-model', 0.99)
    const arena = resolveModelQuality(quality, 'arena-only-free', 0.99)
    const metadata = resolveModelQuality(quality, 'vendor/metadata-only:free', 0.99)

    assert.equal(direct.score, 0.72)
    assert.equal(direct.source, 'artificial-analysis')
    assert.equal(direct.isEstimated, false)
    assert.equal(arena.score, 0.62)
    assert.equal(arena.source, 'design-arena')
    assert.equal(metadata.source, 'metadata')
    assert.ok(metadata.score >= 0.35 && metadata.score <= 0.65)
  })

  it('labels local and blind defaults when no catalog match exists', () => {
    const quality = buildOpenRouterQualityIndex(catalog)
    assert.equal(resolveModelQuality(quality, 'unknown/local', 0.61).source, 'local-fallback')
    assert.equal(resolveModelQuality(quality, 'unknown/blind').score, 0.45)
    assert.equal(resolveModelQuality(quality, 'unknown/blind').source, 'default-fallback')
  })
})

describe('dynamic model score resolution', () => {
  it('extracts Ollama model records from tags payloads', () => {
    const payload = {
      models: [
        { name: 'gpt-oss:120b', model: 'gpt-oss:120b' },
        { name: 'llama3.3', model: 'llama3.3' },
      ],
    }

    assert.deepEqual(extractOllamaModelRecords(payload), payload.models)
    assert.deepEqual(extractOllamaModelRecords(null), [])
  })

  it('uses scores.js entries for Ollama models when available', () => {
    const model = toOllamaModelMeta({
      name: 'openai/gpt-oss-120b',
      model: 'openai/gpt-oss-120b',
    })

    assert.ok(model)
    assert.equal(model.providerKey, 'ollama')
    assert.equal(model.label, 'GPT OSS 120B')
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Ollama-style aliases like qwen3:4b to existing score entries', () => {
    assert.equal(resolveAliasedModelId('qwen3:4b'), 'qwen/qwen3-4b')
    assert.equal(getScore('qwen3:4b'), 0.542)

    const model = toOllamaModelMeta({
      name: 'qwen3:4b',
      model: 'qwen3:4b',
      details: { family: 'qwen3', parameter_size: '4.0B' },
    })

    assert.ok(model)
    assert.equal(model.label, 'Qwen3:4b')
    assert.equal(model.intell, 0.542)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Devstral Small 2 Ollama IDs to a verified score entry', () => {
    assert.equal(resolveAliasedModelId('devstral-small-2:24b'), 'devstral-small-2-24b')
    assert.equal(getScore('devstral-small-2:24b'), 0.658)

    const model = toOllamaModelMeta({
      name: 'devstral-small-2:24b',
      model: 'devstral-small-2:24b',
    })

    assert.ok(model)
    assert.equal(model.label, 'Devstral Small 2 24B')
    assert.equal(model.intell, 0.658)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps common Ollama cloud aliases onto existing benchmark entries', () => {
    assert.equal(getScore('deepseek-v3.2'), 0.731)
    assert.equal(getScore('cogito-2.1:671b'), 0.42)
    assert.equal(getScore('gemma3:4b'), 0.428)
    assert.equal(getScore('glm-5'), 0.778)
    assert.equal(getScore('kimi-k2.5'), 0.768)
    assert.equal(getScore('mimo-v2-pro-free'), 0.78)
    assert.equal(getScore('minimax-m2.5-free'), 0.802)
    assert.equal(getScore('ministral-3:3b'), 0.548)
    assert.equal(getScore('ministral-3:8b'), 0.616)
    assert.equal(getScore('mistral-large-3:675b'), 0.58)
    assert.equal(getScore('nemotron-3-super'), 0.377)
    assert.equal(getScore('qwen/qwen3.6-plus-preview:free'), 0.68)
    assert.equal(getScore('qwen3-vl:235b'), 0.7)
    assert.equal(getScore('qwen3-vl:235b-instruct'), 0.7)
    assert.equal(getScore('qwen3-coder:480b'), 0.706)
    assert.equal(getScore('qwen3-next:80b'), 0.65)
    assert.equal(getScore('qwen3.5:397b'), 0.68)
  })

  it('applies direct score entries for new cloud-only models we track explicitly', () => {
    assert.equal(getScore('gemini-3-flash-preview'), 0.78)
    assert.equal(getScore('qwen3-coder-next'), 0.706)
    assert.equal(getScore('rnj-1:8b'), 0.208)
  })

  it('resolves researched benchmark scores for newly discovered coding models', () => {
    assert.equal(getScore('arcee-ai/trinity-large-thinking:free'), 0.632)
    assert.equal(getScore('bytedance-seed/dola-seed-2.0-pro:free'), 0.765)
    assert.equal(getScore('glm-5.1'), 0.584)
    assert.equal(getScore('google/gemma-4-26b-a4b-it:free'), 0.393)
    assert.equal(getScore('google/gemma-4-31b-it:free'), 0.8)
    assert.equal(getScore('kimi-k2.6'), 0.802)
  })

  it('maps Gemma 4 Ollama aliases onto researched score entries', () => {
    assert.equal(resolveAliasedModelId('gemma4:26b'), 'google/gemma-4-26b-a4b-it')
    assert.equal(resolveAliasedModelId('gemma4:31b'), 'google/gemma-4-31b-it')
    assert.equal(getScore('gemma4:31b'), 0.8)

    const model = toOllamaModelMeta({
      name: 'gemma4:31b',
      model: 'gemma4:31b',
    })

    assert.ok(model)
    assert.equal(model.label, 'Gemma 4 31B')
    assert.equal(model.intell, 0.8)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Ollama cloud remote models to canonical score entries', () => {
    const model = toOllamaModelMeta({
      name: 'Minimax-m2.7:cloud',
      model: 'Minimax-m2.7:cloud',
      remote_model: 'minimax-m2.7',
    })

    assert.ok(model)
    assert.equal(model.intell, 0.822)
    assert.equal(model.isEstimatedScore, false)
  })

  it('does not apply another provider context to Ollama discovery', () => {
    const model = toOllamaModelMeta({
      name: 'kimi-k2.6',
      model: 'kimi-k2.6',
    })

    assert.ok(model)
    assert.equal(model.label, 'Kimi K2.6')
    assert.equal(model.intell, 0.802)
    assert.equal(model.isEstimatedScore, false)
    assert.equal(model.ctx, null)
    assert.equal(model.ctxSource, null)
  })

  it('uses the allocated Ollama context before the model maximum', () => {
    const model = toOllamaModelMeta({
      name: 'gemma3',
      model: 'gemma3',
      _running: { context_length: 4096 },
      _show: { model_info: { 'gemma3.context_length': 131072 } },
    })

    assert.equal(model.ctx, '4096')
    assert.equal(model.ctxSource, 'runtime-allocated')
  })

  it('labels an unallocated Ollama model limit as a model maximum', () => {
    const model = toOllamaModelMeta({
      name: 'gemma3',
      model: 'gemma3',
      _show: { model_info: { 'gemma3.context_length': 131072 } },
    })

    assert.equal(model.ctx, '131072')
    assert.equal(model.ctxSource, 'model-maximum')
  })

  it('keeps MiniMax M-series SWE scores monotonic as versions increase', () => {
    assert.ok(getScore('minimax-m2') < getScore('minimax-m2.1'))
    assert.ok(getScore('minimax-m2.1') < getScore('minimax-m2.5'))
    assert.ok(getScore('minimax-m2.5') < getScore('minimax-m2.7'))
  })

  it('uses scores.js entry for OpenRouter models outside static sources', () => {
    const model = toOpenRouterModelMeta({
      id: 'google/gemma-3n-e2b-it:free',
      name: 'Google: Gemma 3N E2B (free)',
      context_length: 32768,
    })

    assert.ok(model)
    assert.equal(model.intell, 0.25)
    assert.equal(model.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered OpenRouter coding models', () => {
    const gemma = toOpenRouterModelMeta({
      id: 'google/gemma-4-31b-it:free',
      name: 'Google: Gemma 4 31B (free)',
      context_length: 262144,
    })

    assert.ok(gemma)
    assert.equal(gemma.label, 'Gemma 4 31B')
    assert.equal(gemma.intell, 0.8)
    assert.equal(gemma.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered OpenRouter free coding models', () => {
    const cases = [
      ['baidu/cobuddy:free', 0.715],
      ['deepseek-v4-flash-free', 0.521],
      ['inclusionai/ring-2.6-1t:free', 0.727],
      ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 0.138],
      ['poolside/laguna-m.1:free', 0.725],
      ['poolside/laguna-xs.2:free', 0.682],
      ['ring-2.6-1t-free', 0.727],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('uses verified scores for the latest free coding models across providers', () => {
    const cases = [
      ['tencent/hy3:free', 0.78],
      ['hy3-free', 0.78],
      ['poolside/laguna-xs-2.1:free', 0.592],
      ['cohere/north-mini-code:free', 0.365],
      ['north-mini-code-free', 0.365],
      ['nvidia/nemotron-3-ultra-550b-a55b:free', 0.493],
      ['nemotron-3-ultra-free', 0.493],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('resolves every coding model reported by the refresh-scores audit', () => {
    const cases = [
      ['glm-5.2', 0.688],
      ['z-ai/glm-5.2', 0.688],
      ['kimi-k2.7-code', 0.62],
      ['moonshotai/kimi-k2.7-code', 0.62],
      ['mimo-v2.5-free', 0.568],
      ['minimax-m3', 0.586],
      ['minimaxai/minimax-m3', 0.586],
      ['nemotron-3-ultra', 0.493],
      ['stepfun/step-3.7-flash:free', 0.396],
      ['stepfun-ai/step-3.7-flash', 0.396],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('keeps offline fallbacks for the newest discovered free models', () => {
    const cases = [
      ['deepseek-v4-flash:0731', 0.691],
      ['kimi-k3', 0.762],
      ['inclusionai/ling-3.0-flash:free', 0.608],
      ['ling-3.0-flash-free', 0.608],
      ['poolside/laguna-s-2.1:free', 0.625],
      ['laguna-s-2.1-free', 0.625],
    ]
    for (const [modelId, expectedScore] of cases) assert.equal(getScore(modelId), expectedScore)
  })

  it('includes newly available NIM coding models in the static catalog', () => {
    const nvidiaModelIds = new Set(sources.nvidia.models.map(([modelId]) => modelId))
    const expected = [
      'z-ai/glm-5.2',
      'moonshotai/kimi-k2.7-code',
      'minimaxai/minimax-m3',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'stepfun-ai/step-3.7-flash',
    ]

    for (const modelId of expected) {
      assert.equal(nvidiaModelIds.has(modelId), true, `Missing NIM model: ${modelId}`)
    }
  })

  it('ignores safety-only dynamic models that should not be routed as coding models', () => {
    assert.equal(toKiloCodeModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
    assert.equal(toOpenRouterModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
    assert.equal(toKiloCodeModelMeta({ id: 'nvidia/nemotron-3.5-content-safety:free' }), null)
    assert.equal(toOpenRouterModelMeta({ id: 'nvidia/nemotron-3.5-content-safety:free' }), null)
  })

  it('uses scores.js entry for KiloCode models when payload omits scores', () => {
    const model = toKiloCodeModelMeta({
      id: 'google/gemma-3n-e2b-it:free',
      display_name: 'Gemma 3N E2B',
      context_length: 32768,
    })

    assert.ok(model)
    assert.equal(model.intell, 0.25)
    assert.equal(model.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered KiloCode coding models', () => {
    const model = toKiloCodeModelMeta({
      id: 'arcee-ai/trinity-large-thinking:free',
      display_name: 'Arcee Trinity Large Thinking',
    })

    assert.ok(model)
    assert.equal(model.label, 'Trinity Large Thinking')
    assert.equal(model.intell, 0.632)
    assert.equal(model.isEstimatedScore, false)
  })

  it('applies preferred labels to KiloCode dynamic models', () => {
    const model = toKiloCodeModelMeta({
      id: 'xiaomi/mimo-v2-omni:free',
      display_name: 'xiaomi/mimo-v2-omni:free',
    })

    assert.ok(model)
    assert.equal(model.label, 'MiMo V2 Omni')
  })

  it('uses aliased scores.js entries for OpenCode Zen chat models', () => {
    const model = toOpenCodeModelMeta({
      id: 'minimax-m2.5-free',
    })

    assert.ok(model)
    assert.equal(model.label, 'MiniMax M2.5')
    assert.equal(model.intell, 0.802)
    assert.equal(model.isEstimatedScore, false)
  })

  it('does not copy Ling 2.6 context metadata between providers', () => {
    assert.equal(resolveAliasedModelId('ling-2.6-flash-free'), 'inclusionai/ling-2.6-flash')
    assert.equal(resolveAliasedModelId('inclusionai/ling-2.6-flash:free'), 'inclusionai/ling-2.6-flash')
    assert.equal(getScore('ling-2.6-flash-free'), 0.771)
    assert.equal(getScore('inclusionai/ling-2.6-flash:free'), 0.771)
    assert.equal(getPreferredModelContext('ling-2.6-flash-free'), '262k')

    const model = toOpenCodeModelMeta({ id: 'ling-2.6-flash-free' })

    assert.ok(model)
    assert.equal(model.label, 'Ling 2.6 Flash')
    assert.equal(model.ctx, null)
    assert.equal(model.ctxSource, null)
    assert.equal(model.intell, 0.771)
    assert.equal(model.isEstimatedScore, false)

    const openRouterModel = toOpenRouterModelMeta({
      id: 'inclusionai/ling-2.6-flash:free',
      name: 'inclusionAI: Ling-2.6-flash (free)',
      context_length: 262144,
    })

    assert.ok(openRouterModel)
    assert.equal(openRouterModel.intell, 0.771)
    assert.equal(openRouterModel.ctx, '262144')
    assert.equal(openRouterModel.ctxSource, 'provider-reported')
    assert.equal(openRouterModel.isEstimatedScore, false)
  })

  it('deduplicates missing score audit entries by canonical model id', () => {
    assert.equal(normalizeMissingScoreId('ling-2.6-flash-free'), 'inclusionai/ling-2.6-flash')
    assert.equal(normalizeMissingScoreId('inclusionai/ling-2.6-flash:free'), 'inclusionai/ling-2.6-flash')
  })

  it('includes OpenCode Zen free models that end with -free', () => {
    const qwen = toOpenCodeModelMeta({ id: 'qwen3.6-plus-free' })
    const trinity = toOpenCodeModelMeta({ id: 'trinity-large-preview-free' })
    const flash = toOpenCodeModelMeta({ id: 'mimo-v2-flash-free' })

    assert.ok(qwen)
    assert.equal(qwen.intell, 0.68)
    assert.equal(qwen.isEstimatedScore, false)

    assert.ok(trinity)
    assert.equal(trinity.intell, 0.778)
    assert.equal(trinity.isEstimatedScore, false)

    assert.ok(flash)
    assert.equal(flash.intell, 0.734)
    assert.equal(flash.isEstimatedScore, false)
  })

  it('ignores OpenCode Zen models that are not free/chat-compatible for routing', () => {
    assert.equal(toOpenCodeModelMeta({ id: 'gpt-5.4' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'big-pickle' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'glm-5' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'kimi-k2' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'minimax-m2.5' }), null)
  })

  it('applies preferred MiMo display labels', () => {
    assert.equal(getPreferredModelLabel('mimo-v2-omni-free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-omni:free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-pro:free'), 'MiMo V2 Omni Pro')
    assert.equal(getPreferredModelLabel('x-ai/grok-code-fast-1:optimized:free'), 'Grok Code Fast')
    assert.equal(getPreferredModelLabel('minimax-m2.5-free', 'MiniMax M2.5 Free'), 'MiniMax M2.5')
    assert.equal(getPreferredModelLabel('nemotron-3-super-free', 'Nemotron 3 Super Free'), 'Nemotron 3 Super')
  })

  it('preserves Ollama size tags while stripping runtime suffixes', () => {
    assert.deepEqual(canonicalizeModelId('devstral-small-2:24b'), { base: 'devstral-small-2-24b', unprefixed: 'devstral-small-2-24b' })
    assert.deepEqual(canonicalizeModelId('qwen3:4b'), { base: 'qwen/qwen3-4b', unprefixed: 'qwen3-4b' })
    assert.deepEqual(canonicalizeModelId('gpt-oss:120b'), { base: 'openai/gpt-oss-120b', unprefixed: 'gpt-oss-120b' })
    assert.deepEqual(canonicalizeModelId('Minimax-m2.7:cloud'), { base: 'minimax-m2.7', unprefixed: 'minimax-m2.7' })
    assert.deepEqual(canonicalizeModelId('x-ai/grok-code-fast-1:optimized:free'), { base: 'x-ai/grok-code-fast-1', unprefixed: 'grok-code-fast-1' })
  })
})

describe('getAvg', () => {
  it('returns Infinity with no successful pings', () => {
    assert.equal(getAvg(mockResult({ pings: [] })), Infinity)
    assert.equal(getAvg(mockResult({ pings: [{ ms: 20, code: '500' }] })), Infinity)
  })

  it('uses only HTTP 200 pings', () => {
    const result = mockResult({
      pings: [
        { ms: 200, code: '200' },
        { ms: 400, code: '200' },
        { ms: 800, code: '429' },
      ],
    })
    assert.equal(getAvg(result), 300)
  })

  it('applies sliding window when ts is present', () => {
    const now = Date.now()
    const result = mockResult({
      pings: [
        { ms: 100, code: '200', ts: now - 5_000 },
        { ms: 900, code: '200', ts: now - 60_000 },
      ],
    })
    assert.equal(getAvg(result, 10_000), 100)
  })

  it('keeps successful pings within the default long window', () => {
    const now = Date.now()
    const result = mockResult({
      pings: [
        { ms: 240, code: '200', ts: now - 20 * 60_000 },
        { ms: 900, code: '200', ts: now - 40 * 60_000 },
      ],
    })
    assert.equal(getAvg(result), 240)
  })
})

describe('getVerdict', () => {
  it('maps overloaded and inactive states', () => {
    assert.equal(getVerdict(mockResult({ httpCode: '429', pings: [{ ms: 0, code: '429' }] })), 'Overloaded')
    assert.equal(getVerdict(mockResult({ status: 'timeout', pings: [{ ms: 0, code: '000' }] })), 'Not Active')
  })

  it('maps unstable when model was previously up', () => {
    const result = mockResult({
      status: 'down',
      pings: [{ ms: 150, code: '200' }, { ms: 0, code: '500' }],
    })
    assert.equal(getVerdict(result), 'Unstable')
  })

  it('maps latency tiers', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 200, code: '200' }] })), 'Perfect')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 600, code: '200' }] })), 'Normal')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 1_600, code: '200' }] })), 'Slow')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 4_000, code: '200' }] })), 'Very Slow')
  })
})

describe('getUptime', () => {
  it('returns percentage of successful pings', () => {
    assert.equal(getUptime(mockResult({ pings: [] })), 0)
    assert.equal(getUptime(mockResult({ pings: [{ ms: 10, code: '200' }, { ms: 20, code: '200' }] })), 100)
    assert.equal(getUptime(mockResult({ pings: [{ ms: 10, code: '200' }, { ms: 0, code: '500' }] })), 50)
  })
})

describe('sortResults', () => {
  it('sorts by avg', () => {
    const results = [
      mockResult({ label: 'Slow', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'Fast', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'avg', 'asc')
    assert.equal(sorted[0].label, 'Fast')
  })

  it('sorts by verdict using VERDICT_ORDER', () => {
    const results = [
      mockResult({ label: 'Pending', pings: [] }),
      mockResult({ label: 'Perfect', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'verdict', 'asc')
    assert.equal(sorted[0].label, 'Perfect')
    assert.equal(VERDICT_ORDER.includes('Pending'), true)
  })

  it('sorts ctx values with k/m suffixes', () => {
    const results = [
      mockResult({ label: 'Small', ctx: '8k' }),
      mockResult({ label: 'Large', ctx: '1m' }),
      mockResult({ label: 'Mid', ctx: '128k' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.deepEqual(sorted.map(r => r.label), ['Small', 'Mid', 'Large'])
  })

  it('does not mutate the original array', () => {
    const results = [
      mockResult({ label: 'B', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'A', pings: [{ ms: 100, code: '200' }] }),
    ]
    const copy = [...results]
    sortResults(results, 'avg', 'asc')
    assert.equal(results[0].label, copy[0].label)
  })
})

describe('findBestModel', () => {
  it('returns null on empty input', () => {
    assert.equal(findBestModel([]), null)
  })

  it('ignores banned and disabled models', () => {
    const results = [
      mockResult({ label: 'Banned', status: 'banned', pings: [{ ms: 10, code: '200' }] }),
      mockResult({ label: 'Disabled', status: 'disabled', pings: [{ ms: 10, code: '200' }] }),
      mockResult({ label: 'Valid', status: 'up', pings: [{ ms: 300, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Valid')
  })

  it('prefers better QoS among eligible models', () => {
    const results = [
      mockResult({ label: 'Slower', status: 'up', pings: [{ ms: 700, code: '200' }, { ms: 900, code: '200' }] }),
      mockResult({ label: 'Faster', status: 'up', pings: [{ ms: 120, code: '200' }, { ms: 200, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Faster')
  })
})

describe('rankModelsForRouting', () => {
  it('returns candidates sorted by QoS', () => {
    const results = [
      mockResult({ label: 'Slower', status: 'up', pings: [{ ms: 900, code: '200' }] }),
      mockResult({ label: 'Faster', status: 'up', pings: [{ ms: 120, code: '200' }] }),
    ]

    const ranked = rankModelsForRouting(results)
    assert.equal(ranked[0].label, 'Faster')
    assert.equal(ranked[1].label, 'Slower')
  })

  it('excludes requested model IDs and ineligible states', () => {
    const results = [
      mockResult({ modelId: 'a', label: 'A', status: 'up', pings: [{ ms: 100, code: '200' }] }),
      mockResult({ modelId: 'b', label: 'B', status: 'banned', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ modelId: 'c', label: 'C', status: 'disabled', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ modelId: 'd', label: 'D', status: 'up', pings: [{ ms: 300, code: '200' }] }),
    ]

    const ranked = rankModelsForRouting(results, ['a'])
    assert.deepEqual(ranked.map(r => r.modelId), ['d'])
  })
})

describe('latencyScore', () => {
  it('returns 1 at zero latency and 0.5 exactly at the target', () => {
    assert.equal(latencyScore(0, 1000), 1)
    assert.equal(latencyScore(1000, 1000), 0.5)
  })

  it('decays continuously and never saturates to zero', () => {
    const at1s = latencyScore(1_000, 1000)
    const at10s = latencyScore(10_000, 1000)
    const at250s = latencyScore(250_000, 1000)
    assert.ok(at1s > at10s)
    assert.ok(at10s > at250s)
    assert.ok(at250s > 0)
  })

  it('treats missing ping data (Infinity/null avg) as the neutral midpoint', () => {
    assert.equal(latencyScore(Infinity, 1000), 0.5)
    assert.equal(latencyScore(null, 1000), 0.5)
  })

  it('defaults to DEFAULT_QOS_LATENCY_TARGET_MS when no target is given', () => {
    assert.equal(latencyScore(DEFAULT_QOS_LATENCY_TARGET_MS), 0.5)
  })
})

describe('QoS latency weighting (regression: nvidia/z-ai/glm-5.2 sat at a 200-290s avg for ~24h while still ranking near the top by quality score alone)', () => {
  it('a catastrophically slow but high-quality model no longer beats a fast, lower-quality one', () => {
    const catastrophicallySlow = mockResult({
      label: 'HighQualitySlow',
      intell: 0.9,
      pings: [{ ms: 250_000, code: '200' }, { ms: 240_000, code: '200' }],
    })
    const fastButLowerQuality = mockResult({
      label: 'FastLowerQuality',
      intell: 0.3,
      pings: [{ ms: 1_500, code: '200' }, { ms: 1_600, code: '200' }],
    })

    const ranked = rankModelsForRouting([catastrophicallySlow, fastButLowerQuality])
    assert.equal(ranked[0].label, 'FastLowerQuality')
  })

  it('still prefers the higher-quality model when both are reasonably fast', () => {
    const higherQuality = mockResult({ label: 'HigherQuality', intell: 0.9, pings: [{ ms: 1_200, code: '200' }] })
    const lowerQuality = mockResult({ label: 'LowerQuality', intell: 0.3, pings: [{ ms: 900, code: '200' }] })

    const ranked = rankModelsForRouting([higherQuality, lowerQuality])
    assert.equal(ranked[0].label, 'HigherQuality')
  })

  it('a stuck-slow model still scores above zero -- a last resort, not fully excluded', () => {
    const stuckSlow = mockResult({ label: 'StuckSlow', intell: 0.9, pings: [{ ms: 291_194, code: '200' }] })
    assert.ok(computeQoS(stuckSlow) > 0)
  })

  it('is tunable via latencyTargetMs for deployments with different latency expectations', () => {
    const model = mockResult({ intell: 0.5, pings: [{ ms: 5_000, code: '200' }] })
    const strict = computeQoS(model, 500)
    const lenient = computeQoS(model, 10_000)
    assert.ok(lenient > strict)
  })
})

describe('isRetryableProxyStatus', () => {
  it('returns true for 429 and 5xx', () => {
    assert.equal(isRetryableProxyStatus(429), true)
    assert.equal(isRetryableProxyStatus('500'), true)
    assert.equal(isRetryableProxyStatus(503), true)
  })

  it('returns true for 410 (model retired/gone upstream)', () => {
    assert.equal(isRetryableProxyStatus(410), true)
    assert.equal(isRetryableProxyStatus('410'), true)
  })

  it('returns false for non-retryable statuses', () => {
    assert.equal(isRetryableProxyStatus(200), false)
    assert.equal(isRetryableProxyStatus(400), false)
    assert.equal(isRetryableProxyStatus(404), false)
    assert.equal(isRetryableProxyStatus('not-a-status'), false)
  })
})

describe('isRateLimitShapedError', () => {
  it('recognizes a 400 quota/rate-limit style body (Groq TPM overage)', () => {
    assert.equal(isRateLimitShapedError(400, 'Please reduce your message size ... tokens per minute (TPM): Limit 8000'), true)
  })

  it('recognizes other rate-limit/quota phrasing, case-insensitively', () => {
    assert.equal(isRateLimitShapedError(400, 'RATE LIMIT exceeded for this account'), true)
    assert.equal(isRateLimitShapedError(400, 'requests per minute quota exceeded'), true)
    assert.equal(isRateLimitShapedError(403, 'You have exceeded your quota'), true)
    assert.equal(isRateLimitShapedError(400, 'rpm limit hit'), true)
  })

  it('does not mask a genuinely malformed request as retryable', () => {
    assert.equal(isRateLimitShapedError(400, 'Invalid request: "messages" field is required'), false)
    assert.equal(isRateLimitShapedError(400, '{"error":"missing required parameter model"}'), false)
  })

  it('only applies to 400/403 -- other statuses are always false regardless of body', () => {
    assert.equal(isRateLimitShapedError(200, 'tokens per minute'), false)
    assert.equal(isRateLimitShapedError(404, 'rate limit'), false)
    assert.equal(isRateLimitShapedError(500, 'quota exceeded'), false)
    assert.equal(isRateLimitShapedError(429, 'tokens per minute'), false)
  })

  it('returns false for missing, empty, or non-string bodies', () => {
    assert.equal(isRateLimitShapedError(400, null), false)
    assert.equal(isRateLimitShapedError(400, undefined), false)
    assert.equal(isRateLimitShapedError(400, ''), false)
    assert.equal(isRateLimitShapedError(400, { message: 'tokens per minute' }), false)
  })
})

describe('isErrorShapedFirstSseEvent', () => {
  it('recognizes a first chunk with a finish_reason and no content (seen live: AtlasCloud)', () => {
    const event = 'data: {"id":"gen-1","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n'
    assert.equal(isErrorShapedFirstSseEvent(event), true)
  })

  it('recognizes a top-level error object', () => {
    const event = 'data: {"error":{"message":"upstream failed","code":500}}\n\n'
    assert.equal(isErrorShapedFirstSseEvent(event), true)
  })

  it('recognizes an immediate [DONE] with no prior chunk', () => {
    assert.equal(isErrorShapedFirstSseEvent('data: [DONE]\n\n'), true)
  })

  it('does not flag a normal content chunk, even with a trailing finish_reason', () => {
    const contentChunk = 'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
    assert.equal(isErrorShapedFirstSseEvent(contentChunk), false)

    const normalFinish = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    // A healthy stream's *first* chunk is never a bare finish -- this exists to document that the
    // detector only looks at shape, not position; server.js only calls it on the first event.
    assert.equal(isErrorShapedFirstSseEvent(normalFinish), true)
  })

  it('does not flag a tool-call-only finish', () => {
    const toolCallChunk = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"foo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n'
    assert.equal(isErrorShapedFirstSseEvent(toolCallChunk), false)
  })

  it('fails open on unparseable or missing data', () => {
    assert.equal(isErrorShapedFirstSseEvent(''), false)
    assert.equal(isErrorShapedFirstSseEvent(null), false)
    assert.equal(isErrorShapedFirstSseEvent('event: ping\n\n'), false)
    assert.equal(isErrorShapedFirstSseEvent('data: {not valid json\n\n'), false)
  })
})

describe('peekFirstSseEvent', () => {
  function streamFromChunks(chunks) {
    const encoder = new TextEncoder()
    let i = 0
    return new ReadableStream({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(chunks[i]))
        i += 1
      },
    })
  }

  async function readAll(stream) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let out = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (value) out += decoder.decode(value, { stream: true })
      if (done) break
    }
    return out
  }

  it('flags an error-shaped first event and still replays it byte-for-byte', async () => {
    const chunks = ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n']
    const { body, errorShaped } = await peekFirstSseEvent(streamFromChunks(chunks))
    assert.equal(errorShaped, true)
    assert.equal(await readAll(body), chunks.join(''))
  })

  it('does not flag a healthy multi-chunk stream, and replays all of it unchanged', async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const { body, errorShaped } = await peekFirstSseEvent(streamFromChunks(chunks))
    assert.equal(errorShaped, false)
    assert.equal(await readAll(body), chunks.join(''))
  })

  it('splits a single chunk containing two events, without losing the second one', async () => {
    const combined = 'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
    const { body, errorShaped } = await peekFirstSseEvent(streamFromChunks([combined]))
    assert.equal(errorShaped, false)
    assert.equal(await readAll(body), combined)
  })
})

describe('computeFailedRefreshRetryAt', () => {
  it('allows a retry after retryBackoffMs instead of the full refresh TTL', () => {
    const now = 1_000_000_000
    const refreshIntervalMs = 60 * 60_000 // 1 hour, e.g. OpenCode Zen's TTL
    const retryBackoffMs = 2 * 60_000 // 2 minutes
    const stampedAt = computeFailedRefreshRetryAt(now, refreshIntervalMs, retryBackoffMs)

    // Immediately after the failure, the TTL guard (`now - stampedAt < refreshIntervalMs`)
    // must still say "not yet" -- otherwise every failure would retry on every ping cycle.
    assert.equal((now - stampedAt) < refreshIntervalMs, true)
    assert.ok((now - stampedAt) >= refreshIntervalMs - retryBackoffMs)

    // retryBackoffMs later, the TTL guard must allow a retry.
    const afterBackoff = now + retryBackoffMs
    assert.equal((afterBackoff - stampedAt) >= refreshIntervalMs, true)

    // Just before retryBackoffMs elapses, it must still be blocked.
    const justBefore = now + retryBackoffMs - 1
    assert.equal((justBefore - stampedAt) >= refreshIntervalMs, false)
  })

  it('never returns a timestamp in the future relative to a fresh success stamp', () => {
    const now = Date.now()
    const stampedAt = computeFailedRefreshRetryAt(now, 30 * 60_000, 2 * 60_000)
    assert.ok(stampedAt < now)
  })
})

describe('parseContextSize', () => {
  it('parses k and m suffixes into raw token counts', () => {
    assert.equal(parseContextSize('128k'), 128_000)
    assert.equal(parseContextSize('1m'), 1_000_000)
    assert.equal(parseContextSize('1M'), 1_000_000)
    assert.equal(parseContextSize('10M'), 10_000_000)
    assert.equal(parseContextSize('0.5m'), 500_000)
  })

  it('parses plain numbers, string or numeric', () => {
    assert.equal(parseContextSize('32000'), 32_000)
    assert.equal(parseContextSize(32000), 32_000)
  })

  it('returns null for unparseable, empty, or negative input', () => {
    assert.equal(parseContextSize(null), null)
    assert.equal(parseContextSize(undefined), null)
    assert.equal(parseContextSize(''), null)
    assert.equal(parseContextSize('—'), null)
    assert.equal(parseContextSize('not-a-number'), null)
    assert.equal(parseContextSize(-5), null)
    assert.equal(parseContextSize('-5'), null)
    assert.equal(parseContextSize('-5k'), null)
    assert.equal(parseContextSize('128garbage'), null)
    assert.equal(parseContextSize('1.2.3m'), null)
    assert.equal(parseContextSize(0), null)
  })
})

describe('parseArgs', () => {
  const argv = (...args) => ['node', 'script', ...args]

  it('parses router runtime flags', () => {
    const result = parseArgs(argv('--port', '8080', '--ban', 'a,b,c', '--log'))
    assert.equal(result.portValue, 8080)
    assert.deepEqual(result.bannedModels, ['a', 'b', 'c'])
    assert.equal(result.enableLog, true)
  })

  it('defaults to port 7352 and logs disabled', () => {
    const result = parseArgs(argv())
    assert.equal(result.portValue, 7352)
    assert.equal(result.enableLog, false)
  })

  it('lets --no-log override --log', () => {
    const result = parseArgs(argv('--log', '--no-log'))
    assert.equal(result.enableLog, false)
  })

  it('detects onboard subcommand and flag', () => {
    assert.equal(parseArgs(argv('onboard')).onboard, true)
    assert.equal(parseArgs(argv('--onboard')).onboard, true)
  })

  it('detects help aliases', () => {
    assert.equal(parseArgs(argv('--help')).help, true)
    assert.equal(parseArgs(argv('-h')).help, true)
    assert.equal(parseArgs(argv('help')).help, true)
  })

  it('parses autostart command variants', () => {
    const install = parseArgs(argv('install', '--autostart'))
    assert.equal(install.command, 'install')
    assert.equal(install.autostart, true)
    assert.equal(install.autostartAction, 'install')

    const start = parseArgs(argv('start', '--autostart'))
    assert.equal(start.command, 'start')
    assert.equal(start.autostart, true)
    assert.equal(start.autostartAction, 'start')

    const uninstall = parseArgs(argv('uninstall', 'autostart'))
    assert.equal(uninstall.command, 'uninstall')
    assert.equal(uninstall.autostart, true)
    assert.equal(uninstall.autostartAction, 'uninstall')

    const status = parseArgs(argv('status', '--autostart'))
    assert.equal(status.command, 'status')
    assert.equal(status.autostart, true)
    assert.equal(status.autostartAction, 'status')
  })

  it('parses autostart alias commands', () => {
    assert.equal(parseArgs(argv('autostart')).autostartAction, 'status')
    assert.equal(parseArgs(argv('autostart', '--status')).autostartAction, 'status')
    assert.equal(parseArgs(argv('autostart', '--install')).autostartAction, 'install')
    assert.equal(parseArgs(argv('autostart', '--start')).autostartAction, 'start')
    assert.equal(parseArgs(argv('autostart', 'uninstall')).autostartAction, 'uninstall')
  })

  it('parses update subcommand', () => {
    const result = parseArgs(argv('update'))
    assert.equal(result.command, 'update')
    assert.equal(result.autostartAction, null)
  })

  it('parses autoupdate status by default', () => {
    const result = parseArgs(argv('autoupdate'))
    assert.equal(result.command, 'autoupdate')
    assert.equal(result.autoUpdateAction, 'status')
  })

  it('parses autoupdate enable/disable with interval', () => {
    const enabled = parseArgs(argv('autoupdate', '--enable', '--interval', '12'))
    assert.equal(enabled.autoUpdateAction, 'enable')
    assert.equal(enabled.autoUpdateIntervalHours, 12)

    const disabled = parseArgs(argv('autoupdate', '--disable'))
    assert.equal(disabled.autoUpdateAction, 'disable')
    assert.equal(disabled.autoUpdateIntervalHours, null)
  })

  it('parses config export/import commands', () => {
    const exported = parseArgs(argv('config', 'export'))
    assert.equal(exported.command, 'config')
    assert.equal(exported.configAction, 'export')
    assert.equal(exported.configPayload, null)

    const imported = parseArgs(argv('config', 'import', 'mrconf:v1:abc123'))
    assert.equal(imported.command, 'config')
    assert.equal(imported.configAction, 'import')
    assert.equal(imported.configPayload, 'mrconf:v1:abc123')
  })

  it('parses config set-keys command', () => {
    const result = parseArgs(argv('config', 'set-keys', 'kilocode', 'key1,key2,key3'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-keys')
    assert.equal(result.configProvider, 'kilocode')
    assert.equal(result.configKeys, 'key1,key2,key3')
  })

  it('parses config add-key command', () => {
    const result = parseArgs(argv('config', 'add-key', 'nvidia', 'nvapi-extra'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'add-key')
    assert.equal(result.configProvider, 'nvidia')
    assert.equal(result.configKeys, 'nvapi-extra')
  })

  it('parses config remove-key command', () => {
    const result = parseArgs(argv('config', 'remove-key', 'groq', '1'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'remove-key')
    assert.equal(result.configProvider, 'groq')
    assert.equal(result.configKeys, '1')
  })

  it('parses config set-maxturns command', () => {
    const result = parseArgs(argv('config', 'set-maxturns', 'kilocode', '20'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-maxturns')
    assert.equal(result.configProvider, 'kilocode')
    assert.equal(result.configMaxTurns, '20')
  })

  it('parses config set-maxturns with 0 to disable', () => {
    const result = parseArgs(argv('config', 'set-maxturns', 'kilocode', '0'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-maxturns')
    assert.equal(result.configMaxTurns, '0')
  })

  it('parses status command', () => {
    const result = parseArgs(argv('status'))
    assert.equal(result.command, 'status')
  })
})

describe('parseOpenRouterKeyRateLimit', () => {
  it('extracts credit limits from key payload', () => {
    const parsed = parseOpenRouterKeyRateLimit({
      data: {
        limit: 25,
        limit_remaining: 12.5,
        limit_reset: '2026-03-01T00:00:00.000Z',
      }
    })

    assert.equal(parsed.creditLimit, 25)
    assert.equal(parsed.creditRemaining, 12.5)
    assert.equal(parsed.creditResetAt, Date.parse('2026-03-01T00:00:00.000Z'))
  })

  it('parses deprecated nested rate_limit shape when present', () => {
    const parsed = parseOpenRouterKeyRateLimit({
      data: {
        rate_limit: {
          limit_requests: 20,
          remaining_requests: 8,
          reset_requests: 120,
          limit_tokens: 40000,
          remaining_tokens: 15000,
          reset_tokens: 45,
        }
      }
    })

    assert.equal(parsed.limitRequests, 20)
    assert.equal(parsed.remainingRequests, 8)
    assert.equal(parsed.limitTokens, 40000)
    assert.equal(parsed.remainingTokens, 15000)
    assert.ok(parsed.resetRequestsAt > Date.now())
    assert.ok(parsed.resetTokensAt > Date.now())
  })

  it('returns null for invalid payloads', () => {
    assert.equal(parseOpenRouterKeyRateLimit(null), null)
    assert.equal(parseOpenRouterKeyRateLimit({ data: {} }), null)
  })
})

describe('update restart coordination', () => {
  it('keeps Unix-like services alive long enough to self-update when restart is deferred', () => {
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'linux'), false)
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'darwin'), false)
  })

  it('still stops background instances for normal updates and Windows handoff', () => {
    assert.equal(shouldStopAutostartBeforeUpdate(false, 'linux'), true)
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'win32'), true)
  })
})

describe('local update overrides', () => {
  it('detects local tarball updates and derives the version from the filename', () => {
    const tarballPath = join(ROOT, 'modelrelay-9.8.7.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ MODELRELAY_UPDATE_TARBALL: tarballPath, MODELRELAY_UPDATE_VERSION: null }, () => {
        assert.equal(getLocalUpdateTarballPath(), tarballPath)
        assert.equal(getLocalUpdateVersion(), '9.8.7')
        assert.equal(isRunningFromSource(), false)
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })

  it('prefers an explicit local update version override', () => {
    const tarballPath = join(ROOT, 'modelrelay-build-under-test.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ MODELRELAY_UPDATE_TARBALL: tarballPath, MODELRELAY_UPDATE_VERSION: '3.2.1' }, () => {
        assert.equal(getLocalUpdateVersion(), '3.2.1')
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })

  it('accepts a forced update version for simpler local upgrade testing', () => {
    withEnv({ MODELRELAY_FORCE_UPDATE_VERSION: '9.9.9' }, () => {
      assert.equal(getForcedUpdateVersion(), '9.9.9')
    })
  })

  it('ignores invalid forced update versions', () => {
    withEnv({ MODELRELAY_FORCE_UPDATE_VERSION: 'next-build' }, () => {
      assert.equal(getForcedUpdateVersion(), null)
    })
  })
})

describe('npm install invocation', () => {
  it('builds a shell-safe Windows npm command for local tarballs', () => {
    const tarballPath = join(ROOT, 'modelrelay-1.8.4.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ MODELRELAY_UPDATE_TARBALL: tarballPath }, () => {
        const invocation = buildNpmInstallInvocation('latest', 'win32')
        assert.equal(invocation.command, 'npm')
        assert.deepEqual(invocation.args, ['install', '-g', tarballPath])
        assert.equal(invocation.shell, true)
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })
})

describe('post-update restart command', () => {
  it('restarts the autostart target only when autostart is configured', () => {
    assert.equal(buildWindowsPostUpdateRestartCommand(true), 'timeout /t 2 /nobreak && modelrelay start --autostart')
    assert.equal(buildWindowsPostUpdateRestartCommand(false), 'timeout /t 2 /nobreak && modelrelay')
  })
})

describe('autostart', () => {
  it('resolves absolute executable path when available', () => {
    const binPath = join(ROOT, 'bin', 'modelrelay.js')
    assert.equal(resolveAutostartExecPath(binPath), binPath)
  })

  it('falls back to command name when path is missing', () => {
    assert.equal(resolveAutostartExecPath('/definitely/not/a/file/modelrelay'), 'modelrelay')
  })

  it('resolves node executable path when available', () => {
    assert.equal(resolveAutostartNodePath(process.execPath), process.execPath)
  })

  it('falls back to node command when node path is missing', () => {
    assert.equal(resolveAutostartNodePath('/definitely/not/a/file/node'), 'node')
  })
})

describe('onboard integrations', () => {
  it('builds OpenClaw provider config with required models array', () => {
    const provider = buildOpenClawProviderConfig(7352)

    assert.equal(provider.baseUrl, 'http://127.0.0.1:7352/v1')
    assert.equal(provider.api, 'openai-completions')
    assert.equal(provider.apiKey, 'no-key')
    assert.deepEqual(provider.models, [{ id: 'auto-fastest', name: 'Auto Fastest' }])
  })

  it('adds routing presets only when asked, with contextWindow matching min_ctx', () => {
    const withPresets = buildOpenClawProviderConfig(7352, { presets: true })
    assert.deepEqual(withPresets.models.map(m => m.id), ['auto-fastest', ...OPENCLAW_ROUTING_PRESETS.map(p => p.id)])
    const coding = withPresets.models.find(m => m.id === 'tag:coding+min_ctx:64k')
    assert.equal(coding.contextWindow, 65536)
    assert.equal(buildOpenClawProviderConfig(7352).models.length, 1)
  })

  it('applyOpenClawConfig keeps auto-fastest primary and allowlists presets', () => {
    const config = applyOpenClawConfig({}, 7352, { presets: true })
    assert.equal(config.agents.defaults.model.primary, 'modelrelay/auto-fastest')
    for (const preset of OPENCLAW_ROUTING_PRESETS) assert.ok(config.agents.defaults.models[`modelrelay/${preset.id}`])
    assert.ok(config.agents.defaults.models['modelrelay/auto-fastest'])
  })

  it('applyOpenClawConfig preserves hand-added selectors and unrelated config on re-run', () => {
    const existing = {
      theme: 'dark',
      models: { providers: { other: { baseUrl: 'x' }, modelrelay: { models: [{ id: 'auto-fastest', name: 'old' }, { id: 'tag:reasoning+min_ctx:32k', name: 'Reasoning' }] } } },
      agents: { defaults: { models: { 'modelrelay/tag:reasoning+min_ctx:32k': {} } } },
    }
    const config = applyOpenClawConfig(existing, 7400)
    assert.equal(config.theme, 'dark')
    assert.deepEqual(config.models.providers.other, { baseUrl: 'x' })
    assert.equal(config.models.providers.modelrelay.baseUrl, 'http://127.0.0.1:7400/v1')
    assert.deepEqual(config.models.providers.modelrelay.models.map(m => m.id), ['auto-fastest', 'tag:reasoning+min_ctx:32k'])
    assert.equal(config.models.providers.modelrelay.models[0].name, 'Auto Fastest')
    assert.ok(config.agents.defaults.models['modelrelay/tag:reasoning+min_ctx:32k'])
  })
})

describe('model grouping and filtering', () => {
  const results = [
    mockResult({ modelId: 'nvidia/glm4.7', label: 'GLM 4.7 (NVIDIA)' }),
    mockResult({ modelId: 'openrouter/glm4.7:free', label: 'GLM 4.7 (OpenRouter)' }),
    mockResult({ modelId: 'meta/llama3.3-70b', label: 'Llama 3.3 (Meta)' }),
  ]

  it('builds one catalog entry per normalized label group', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' }),
      mockResult({ modelId: 'openrouter/moonshotai/kimi-k2.5:free', label: 'Kimi K2.5' }),
      mockResult({ modelId: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking' }),
    ], canonicalizeModelId)

    assert.equal(groups.length, 2)
    const kimiGroup = groups.find(group => group.id === 'kimi-k2.5')
    assert.ok(kimiGroup)
    assert.equal(kimiGroup.label, 'Kimi K2.5')
    assert.equal(kimiGroup.models.length, 2)
    assert.ok(kimiGroup.aliases.includes('kimi k2.5'))
    assert.ok(kimiGroup.aliases.includes('moonshotai/kimi-k2.5'))
    assert.ok(kimiGroup.aliases.includes('kimi-k2.5'))
  })

  it('uses the canonical unprefixed model id for grouped entries', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'minimax/minimax-m2.5:free', label: 'MiniMax M2.5' }),
      mockResult({ modelId: 'vendor/minimax-m2.5', label: 'MiniMax M2.5' }),
    ], canonicalizeModelId)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, 'minimax-m2.5')
  })

  it('keeps duplicate raw model ids from different providers addressable', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local' }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote' }),
    ], canonicalizeModelId)

    assert.deepEqual(groups.map(group => group.id).sort(), [
      'openai-compatible:local/llama-3.1',
      'openai-compatible:remote/llama-3.1',
    ])
  })

  it('groups MiMo Omni aliases under one model name', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'mimo-v2-omni-free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-omni:free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-pro:free', label: 'MiMo V2 Omni Pro' }),
    ], canonicalizeModelId)

    const omniGroup = groups.find(group => group.id === 'mimo-v2-omni')
    assert.ok(omniGroup)
    assert.equal(omniGroup.label, 'MiMo V2 Omni')
    assert.equal(omniGroup.models.length, 2)
    assert.ok(omniGroup.aliases.includes('mimo-v2-omni-free'))
    assert.ok(omniGroup.aliases.includes('xiaomi/mimo-v2-omni:free'))

    const proGroup = groups.find(group => group.id === 'mimo-v2-pro')
    assert.ok(proGroup)
    assert.equal(proGroup.label, 'MiMo V2 Omni Pro')
    assert.equal(proGroup.models.length, 1)
  })

  it('filters by exact model ID', () => {
    const filtered = filterModelsByRequested(results, 'nvidia/glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].modelId, 'nvidia/glm4.7')
  })

  it('filters by canonical base ID (removes :free)', () => {
    const filtered = filterModelsByRequested(results, 'openrouter/glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].modelId, 'openrouter/glm4.7:free')
  })

  it('filters by unprefixed canonical name (grouping)', () => {
    const filtered = filterModelsByRequested(results, 'glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.some(r => r.modelId === 'nvidia/glm4.7'))
    assert.ok(filtered.some(r => r.modelId === 'openrouter/glm4.7:free'))
  })

  it('filters by MiMo Omni alias name', () => {
    const filtered = filterModelsByRequested([
      mockResult({ modelId: 'mimo-v2-omni-free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-omni:free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-pro:free', label: 'MiMo V2 Omni Pro' }),
    ], 'mimo-v2-omni', canonicalizeModelId)

    assert.equal(filtered.length, 2)
    assert.ok(filtered.some(r => r.modelId === 'mimo-v2-omni-free'))
    assert.ok(filtered.some(r => r.modelId === 'xiaomi/mimo-v2-omni:free'))
  })

  it('canonicalizes stacked model suffixes', () => {
    const canonical = canonicalizeModelId('x-ai/grok-code-fast-1:optimized:free')
    assert.equal(canonical.base, 'x-ai/grok-code-fast-1')
    assert.equal(canonical.unprefixed, 'grok-code-fast-1')
  })

  it('returns no models if no match is found', () => {
    const filtered = filterModelsByRequested(results, 'non-existent-model', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })

  it('returns all models for auto-fastest', () => {
    const filtered = filterModelsByRequested(results, 'auto-fastest', canonicalizeModelId)
    assert.equal(filtered.length, 3)
  })

  it('filters duplicate raw model ids by endpoint-qualified group id', () => {
    const duplicateResults = [
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local' }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote' }),
    ]

    const filtered = filterModelsByRequested(duplicateResults, 'openai-compatible:remote/llama-3.1', canonicalizeModelId)

    assert.deepEqual(filtered.map(r => r.providerKey), ['openai-compatible:remote'])
  })
})

describe('model tag routing', () => {
  // moonshotai/kimi-k2.7-code -> ['coding'], qwen-qwq-32b -> ['reasoning'], z-ai/glm5 -> ['agentic', 'coding', 'general']
  const taggedResults = [
    mockResult({ modelId: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' }),
    mockResult({ modelId: 'qwen-qwq-32b', label: 'QwQ 32B' }),
    mockResult({ modelId: 'z-ai/glm5', label: 'GLM 5' }),
  ]

  it('routes tag: requests to models carrying that tag', () => {
    const filtered = filterModelsByRequested(taggedResults, 'tag:reasoning', canonicalizeModelId)
    assert.deepEqual(filtered.map(r => r.modelId), ['qwen-qwq-32b'])
  })

  it('matches a model tagged with multiple tags under each of its tags', () => {
    const codingMatches = filterModelsByRequested(taggedResults, 'tag:coding', canonicalizeModelId)
    assert.ok(codingMatches.some(r => r.modelId === 'moonshotai/kimi-k2.7-code'))
    assert.ok(codingMatches.some(r => r.modelId === 'z-ai/glm5'))

    const agenticMatches = filterModelsByRequested(taggedResults, 'tag:agentic', canonicalizeModelId)
    assert.deepEqual(agenticMatches.map(r => r.modelId), ['z-ai/glm5'])
  })

  it('is case-insensitive for tag names', () => {
    const filtered = filterModelsByRequested(taggedResults, 'TAG:Reasoning', canonicalizeModelId)
    assert.deepEqual(filtered.map(r => r.modelId), ['qwen-qwq-32b'])
  })

  it('returns no models for an unknown tag', () => {
    const filtered = filterModelsByRequested(taggedResults, 'tag:nonexistent', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })

  it('returns no models when no result carries the requested tag', () => {
    const filtered = filterModelsByRequested([mockResult({ modelId: 'moonshotai/kimi-k2.7-code' })], 'tag:reasoning', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })
})

describe('pinned model routing', () => {
  const results = [
    mockResult({ modelId: 'nvidia/glm4.7', label: 'GLM 4.7', providerKey: 'nvidia', pings: [{ ms: 90, code: '200' }], intell: 0.7 }),
    mockResult({ modelId: 'glm4.7', label: 'GLM 4.7', providerKey: 'vendor-a', pings: [{ ms: 120, code: '200' }], intell: 0.69 }),
    mockResult({ modelId: 'glm4.7', label: 'GLM 4.7', providerKey: 'vendor-b', pings: [{ ms: 150, code: '200' }], intell: 0.65 }),
    mockResult({ modelId: 'openrouter/glm4.7:free', label: 'GLM 4.7', providerKey: 'openrouter', pings: [{ ms: 140, code: '200' }], intell: 0.68 }),
  ]

  it('matches the full canonical group by default', () => {
    const matches = getPinnedModelMatches(results, 'nvidia/glm4.7', 'canonical')
    assert.deepEqual(matches.map(r => `${r.providerKey}:${r.modelId}`), [
      'nvidia:nvidia/glm4.7',
      'vendor-a:glm4.7',
      'vendor-b:glm4.7',
      'openrouter:openrouter/glm4.7:free',
    ])
  })

  it('matches only the exact row in exact mode', () => {
    const matches = getPinnedModelMatches(results, 'glm4.7', 'exact', 'vendor-a')
    assert.deepEqual(matches.map(r => `${r.providerKey}:${r.modelId}`), ['vendor-a:glm4.7'])
  })

  it('routes to the best eligible provider within a canonical pin group', () => {
    const candidate = getPinnedModelCandidate(results, 'nvidia/glm4.7', 'canonical')
    assert.equal(candidate?.modelId, 'nvidia/glm4.7')
  })

  it('can retry another provider with the same raw model id', () => {
    const duplicateResults = [
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local', pings: [{ ms: 90, code: '200' }], intell: 10 }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote', pings: [{ ms: 100, code: '200' }], intell: 10 }),
    ]
    const first = rankModelsForRouting(duplicateResults)[0]
    const second = rankModelsForRouting(duplicateResults, [getRoutingModelKey(first)])[0]

    assert.equal(first.providerKey, 'openai-compatible:local')
    assert.equal(second.providerKey, 'openai-compatible:remote')
  })
})

describe('package and entrypoint sanity', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const binContent = readFileSync(join(ROOT, 'bin/modelrelay.js'), 'utf8')
  const dashboardContent = readFileSync(join(ROOT, 'public/index.html'), 'utf8')

  it('package fields are valid', () => {
    assert.ok(pkg.name)
    assert.ok(pkg.version)
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
    assert.equal(pkg.type, 'module')
    assert.ok(pkg.bin.modelrelay)
    assert.ok(existsSync(join(ROOT, pkg.bin.modelrelay)))
  })

  it('CLI script has shebang and required imports', () => {
    assert.ok(binContent.startsWith('#!/usr/bin/env node'))
    assert.ok(binContent.includes("from '../lib/utils.js'"))
    assert.ok(binContent.includes("from '../lib/onboard.js'"))
  })

  it('labels dashboard scores by the current coding-quality source', () => {
    assert.ok(dashboardContent.includes('>Coding <i class="sort-arrow"'))
    assert.ok(dashboardContent.includes('Artificial Analysis coding index'))
    assert.ok(dashboardContent.includes('Design Arena estimate'))
    assert.ok(dashboardContent.includes('Metadata estimate'))
    assert.equal(dashboardContent.includes('>SWE% <i class="sort-arrow"'), false)
    assert.equal(dashboardContent.includes('>SWE-bench</div>'), false)
  })

  it('includes the model tag editor and tag-routing guidance', () => {
    assert.ok(dashboardContent.includes('id="model-tags-input"'))
    assert.ok(dashboardContent.includes("fetch('/api/models/tags'"))
    assert.ok(dashboardContent.includes('Use <code>tag:name</code>'))
  })

  it('formats exact context sizes for display without changing routing data', () => {
    assert.match(dashboardContent, /function formatContextDisplay\(value\)/)
    assert.match(dashboardContent, /Math\.round\(tokens \/ 1_000\).*K/)
    assert.match(dashboardContent, /formatContextDisplay\(m\.ctx\)/)
  })

  it('includes working provider key reveal and copy controls', () => {
    assert.ok(dashboardContent.includes('toggleProviderKeyVisibility'))
    assert.ok(dashboardContent.includes('getConfiguredProviderKey'))
    assert.ok(dashboardContent.includes('copyProviderKey'))
  })
})

describe('multi-account round-robin', () => {
  describe('getApiKeyPool', () => {
    it('returns single-element array for string key', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.deepEqual(getApiKeyPool(config, 'nvidia'), ['nvapi-key1'])
    })

    it('returns array for array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2', 'key3'] } }
      assert.deepEqual(getApiKeyPool(config, 'kilocode'), ['key1', 'key2', 'key3'])
    })

    it('returns empty array for missing provider', () => {
      const config = { apiKeys: {} }
      assert.deepEqual(getApiKeyPool(config, 'nvidia'), [])
    })

    it('filters empty strings from array', () => {
      const config = { apiKeys: { groq: ['key1', '', '  ', 'key2'] } }
      assert.deepEqual(getApiKeyPool(config, 'groq'), ['key1', 'key2'])
    })

    it('trims whitespace from keys', () => {
      const config = { apiKeys: { groq: ['  key1  ', '  key2  '] } }
      assert.deepEqual(getApiKeyPool(config, 'groq'), ['key1', 'key2'])
    })

    it('env var overrides return single-element array', () => {
      withEnv({ NVIDIA_API_KEY: 'env-key' }, () => {
        const config = { apiKeys: { nvidia: ['file-key1', 'file-key2'] } }
        assert.deepEqual(getApiKeyPool(config, 'nvidia'), ['env-key'])
      })
    })

    it('ignores Qwen-specific env vars for the removed provider', () => {
      withEnv({ DASHSCOPE_API_KEY: 'dashscope-key' }, () => {
        assert.deepEqual(getApiKeyPool({ apiKeys: {} }, 'qwencode'), [])
      })
      withEnv({ QWEN_CODE_API_KEY: 'qwen-code-key' }, () => {
        assert.deepEqual(getApiKeyPool({ apiKeys: {} }, 'qwencode'), [])
      })
    })
  })

  describe('getApiKey backward compatibility', () => {
    it('returns first element for array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2', 'key3'] } }
      assert.equal(getApiKey(config, 'kilocode'), 'key1')
    })

    it('returns string for string keys', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.equal(getApiKey(config, 'nvidia'), 'nvapi-key1')
    })

    it('returns null for empty array', () => {
      const config = { apiKeys: { groq: [] } }
      assert.equal(getApiKey(config, 'groq'), null)
    })
  })

  describe('hasMultipleKeys', () => {
    it('returns true for multiple array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2'] } }
      assert.equal(hasMultipleKeys(config, 'kilocode'), true)
    })

    it('returns false for single string key', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.equal(hasMultipleKeys(config, 'nvidia'), false)
    })

    it('returns false for single-element array', () => {
      const config = { apiKeys: { groq: ['key1'] } }
      assert.equal(hasMultipleKeys(config, 'groq'), false)
    })

    it('returns false for missing provider', () => {
      assert.equal(hasMultipleKeys({ apiKeys: {} }, 'nvidia'), false)
    })
  })

  describe('getMaxTurns', () => {
    it('returns configured value', () => {
      const config = { providers: { kilocode: { maxTurns: 20 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 20)
    })

    it('returns 0 when not configured', () => {
      assert.equal(getMaxTurns({ providers: {} }, 'kilocode'), 0)
      assert.equal(getMaxTurns({ providers: { kilocode: {} } }, 'kilocode'), 0)
    })

    it('returns 0 for invalid values', () => {
      const config = { providers: { kilocode: { maxTurns: -1 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 0)
      const config2 = { providers: { kilocode: { maxTurns: 'abc' } } }
      assert.equal(getMaxTurns(config2, 'kilocode'), 0)
    })

    it('floors fractional values', () => {
      const config = { providers: { kilocode: { maxTurns: 10.7 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 10)
    })
  })

  describe('normalizeConfigShape with arrays', () => {
    it('normalizes array apiKeys by trimming and filtering', () => {
      const config = {
        apiKeys: { kilocode: ['  key1  ', '', 'key2'] },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.deepEqual(normalized.apiKeys.kilocode, ['key1', 'key2'])
    })

    it('preserves string apiKeys unchanged', () => {
      const config = {
        apiKeys: { nvidia: '  nv-key  ' },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.equal(normalized.apiKeys.nvidia, 'nv-key')
    })

    it('handles mixed string and array apiKeys', () => {
      const config = {
        apiKeys: { nvidia: 'nv-key', kilocode: ['key1', 'key2'] },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.equal(normalized.apiKeys.nvidia, 'nv-key')
      assert.deepEqual(normalized.apiKeys.kilocode, ['key1', 'key2'])
    })

    it('round-trips through export/import with array keys', () => {
      const config = {
        apiKeys: { kilocode: ['key1', 'key2'], nvidia: 'nv-key' },
        providers: { kilocode: { enabled: true } },
      }
      const token = exportConfigToken(config)
      const imported = importConfigToken(token)
      assert.deepEqual(imported.apiKeys.kilocode, ['key1', 'key2'])
      assert.equal(imported.apiKeys.nvidia, 'nv-key')
    })
  })

  describe('getAccountStatus', () => {
    it('returns empty when pool state is not initialized', () => {
      const result = getAccountStatus({ apiKeys: { kilocode: ['k1', 'k2'] } })
      assert.deepEqual(result, { providers: {} })
    })
  })

  describe('selectNextApiKeyFromPool', () => {
    it('returns null when every key is still inside cooldown', () => {
      const now = 1_000_000
      const pool = ['key1', 'key2']
      const entry = {
        currentIdx: 0,
        accounts: new Map([
          [0, { requests: 1, rateLimitedAt: now - 10_000 }],
          [1, { requests: 1, rateLimitedAt: now - 20_000 }],
        ]),
      }

      const selected = selectNextApiKeyFromPool(pool, entry, 0, now, 60_000)

      assert.equal(selected, null)
      assert.equal(entry.currentIdx, 0)
      assert.equal(entry.accounts.get(0).requests, 1)
      assert.equal(entry.accounts.get(1).requests, 1)
    })

    it('resets counters when only maxTurns exhaustion blocks the pool', () => {
      const now = 1_000_000
      const pool = ['key1', 'key2']
      const entry = {
        currentIdx: 0,
        accounts: new Map([
          [0, { requests: 2, rateLimitedAt: 0 }],
          [1, { requests: 2, rateLimitedAt: 0 }],
        ]),
      }

      const selected = selectNextApiKeyFromPool(pool, entry, 2, now, 60_000)

      assert.equal(selected, 'key1')
      assert.equal(entry.currentIdx, 1)
      assert.equal(entry.accounts.get(0).requests, 1)
      assert.equal(entry.accounts.get(1).requests, 0)
    })
  })
})

describe('OpenAI-compatible multi-instance support', () => {
  it('detects instance keys and extracts ids', () => {
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible:default'), true)
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible:my-vllm'), true)
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible'), false)
    assert.equal(isOpenAICompatibleInstanceKey('groq'), false)

    assert.equal(getOpenAICompatibleInstanceId('openai-compatible:my-vllm'), 'my-vllm')
    assert.equal(getOpenAICompatibleInstanceId('groq'), null)

    assert.equal(getBaseProviderKey('openai-compatible:my-vllm'), 'openai-compatible')
    assert.equal(getBaseProviderKey('groq'), 'groq')
  })

  it('builds instance keys from human-friendly names', () => {
    assert.equal(buildOpenAICompatibleInstanceKey('My vLLM '), 'openai-compatible:my-vllm')
    assert.equal(buildOpenAICompatibleInstanceKey('Foo Bar 123'), 'openai-compatible:foo-bar-123')
    assert.equal(buildOpenAICompatibleInstanceKey(''), null)
    assert.equal(buildOpenAICompatibleInstanceKey('!!!'), null)
  })

  it('normalizeConfigShape migrates a legacy bare-key config to :default', () => {
    const legacy = {
      apiKeys: { 'openai-compatible': 'sk-legacy' },
      providers: { 'openai-compatible': { enabled: true, baseUrl: 'https://legacy.example/v1', modelId: 'old/model' } },
    }
    const normalized = normalizeConfigShape(legacy)
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
    assert.equal(normalized.apiKeys['openai-compatible:default'], 'sk-legacy')
    assert.deepEqual(normalized.providers['openai-compatible:default'], {
      enabled: true,
      baseUrl: 'https://legacy.example/v1',
      modelId: 'old/model',
      name: 'Default',
    })
  })

  it('normalizeConfigShape leaves a config without legacy entries alone', () => {
    const cfg = {
      apiKeys: { 'openai-compatible:my-vllm': 'sk-vllm' },
      providers: { 'openai-compatible:my-vllm': { name: 'vLLM', baseUrl: 'http://localhost:8000/v1', modelId: 'qwen' } },
    }
    const normalized = normalizeConfigShape(cfg)
    assert.equal(normalized.apiKeys['openai-compatible:my-vllm'], 'sk-vllm')
    assert.equal(normalized.providers['openai-compatible:my-vllm'].baseUrl, 'http://localhost:8000/v1')
    // The bare entry should not be (re)created.
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
  })

  it('normalizeConfigShape does not clobber an existing :default instance', () => {
    const legacy = {
      apiKeys: {
        'openai-compatible': 'sk-legacy',
        'openai-compatible:default': 'sk-already-here',
      },
      providers: {
        'openai-compatible': { baseUrl: 'https://legacy.example/v1' },
        'openai-compatible:default': { name: 'Pre-existing', baseUrl: 'https://default.example/v1', modelId: 'm' },
      },
    }
    const normalized = normalizeConfigShape(legacy)
    assert.equal(normalized.apiKeys['openai-compatible:default'], 'sk-already-here')
    assert.equal(normalized.providers['openai-compatible:default'].name, 'Pre-existing')
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
  })

  it('legacy OPENAI_COMPATIBLE_* env vars feed the :default instance', () => {
    const originalKey = process.env.OPENAI_COMPATIBLE_API_KEY
    const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const originalModel = process.env.OPENAI_COMPATIBLE_MODEL

    try {
      process.env.OPENAI_COMPATIBLE_API_KEY = 'env-key'
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://env.example/v1'
      process.env.OPENAI_COMPATIBLE_MODEL = 'env/model'

      const config = { apiKeys: {}, providers: {} }
      assert.equal(getApiKey(config, 'openai-compatible:default'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible:default'), 'https://env.example/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible:default'), 'env/model')

      // Env vars should NOT apply to a non-default instance.
      assert.equal(getApiKey(config, 'openai-compatible:other'), null)
      assert.equal(getProviderBaseUrl(config, 'openai-compatible:other'), null)
    } finally {
      if (originalKey == null) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = originalKey
      if (originalBaseUrl == null) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBaseUrl
      if (originalModel == null) delete process.env.OPENAI_COMPATIBLE_MODEL
      else process.env.OPENAI_COMPATIBLE_MODEL = originalModel
    }
  })

  it('listOpenAICompatibleEndpoints returns instances in stable insertion order', () => {
    const config = normalizeConfigShape({
      apiKeys: {
        'openai-compatible:alpha': 'sk-a',
        'openai-compatible:beta': 'sk-b',
      },
      providers: {
        'openai-compatible:alpha': { name: 'Alpha', baseUrl: 'https://a/v1', modelId: 'a-model' },
        'openai-compatible:beta':  { name: 'Beta',  baseUrl: 'https://b/v1', modelId: 'b-model', enabled: false },
      },
    })

    const list = listOpenAICompatibleEndpoints(config)
    assert.equal(list.length, 2)
    assert.equal(list[0].instanceKey, 'openai-compatible:alpha')
    assert.equal(list[0].id, 'alpha')
    assert.equal(list[0].name, 'Alpha')
    assert.equal(list[0].baseUrl, 'https://a/v1')
    assert.equal(list[0].modelId, 'a-model')
    assert.equal(list[0].apiKey, 'sk-a')
    assert.equal(list[0].enabled, true)

    assert.equal(list[1].instanceKey, 'openai-compatible:beta')
    assert.equal(list[1].enabled, false)
  })

  it('upsertOpenAICompatibleEndpoint and remove round-trip cleanly', () => {
    const config = { apiKeys: {}, providers: {} }
    const key1 = upsertOpenAICompatibleEndpoint(config, { id: 'one', name: 'One', baseUrl: 'https://one/v1', modelId: 'm1', apiKey: 'sk-1' })
    assert.equal(key1, 'openai-compatible:one')
    assert.equal(config.apiKeys[key1], 'sk-1')
    assert.equal(config.providers[key1].baseUrl, 'https://one/v1')
    assert.equal(config.providers[key1].name, 'One')

    // Update preserves untouched fields.
    upsertOpenAICompatibleEndpoint(config, { instanceKey: key1, modelId: 'm1-new' })
    assert.equal(config.providers[key1].baseUrl, 'https://one/v1')
    assert.equal(config.providers[key1].modelId, 'm1-new')

    const removed = removeOpenAICompatibleEndpoint(config, key1)
    assert.equal(removed, true)
    assert.equal(config.apiKeys[key1], undefined)
    assert.equal(config.providers[key1], undefined)

    // Removing again is a no-op.
    assert.equal(removeOpenAICompatibleEndpoint(config, key1), false)
    // Refusing to remove a non-instance key.
    assert.equal(removeOpenAICompatibleEndpoint(config, 'groq'), false)
  })

  it('upsertOpenAICompatibleEndpoint persists discoverModels=false explicitly', () => {
    const config = { apiKeys: {}, providers: {} }
    upsertOpenAICompatibleEndpoint(config, { id: 'one', name: 'One', baseUrl: 'http://h/v1' })
    assert.equal(config.providers['openai-compatible:one'].discoverModels, undefined)

    upsertOpenAICompatibleEndpoint(config, { instanceKey: 'openai-compatible:one', discoverModels: false })
    assert.equal(config.providers['openai-compatible:one'].discoverModels, false)

    upsertOpenAICompatibleEndpoint(config, { instanceKey: 'openai-compatible:one', discoverModels: true })
    assert.equal('discoverModels' in config.providers['openai-compatible:one'], false)
  })

  it('config export/import preserves multi-instance shape', () => {
    const original = normalizeConfigShape({
      apiKeys: {
        'openai-compatible:alpha': 'sk-a',
        'openai-compatible:beta': 'sk-b',
      },
      providers: {
        'openai-compatible:alpha': { name: 'Alpha', baseUrl: 'https://a/v1', modelId: 'a-model' },
        'openai-compatible:beta':  { name: 'Beta',  baseUrl: 'https://b/v1', modelId: 'b-model' },
      },
    })

    const token = exportConfigToken(original)
    const reimported = importConfigToken(token)

    assert.equal(reimported.apiKeys['openai-compatible:alpha'], 'sk-a')
    assert.equal(reimported.apiKeys['openai-compatible:beta'], 'sk-b')
    assert.equal(reimported.providers['openai-compatible:alpha'].name, 'Alpha')
    assert.equal(reimported.providers['openai-compatible:beta'].modelId, 'b-model')
  })
})

describe('OpenAI-compatible model discovery', () => {
  it('builds the /v1/models URL from a variety of base URLs', () => {
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('api.example.com/v1'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl(''), null)
    assert.equal(buildOpenAICompatibleModelsListUrl(null), null)
  })

  it('extracts records from common payload shapes', () => {
    assert.deepEqual(extractOpenAICompatibleModelRecords({ data: [{ id: 'a' }, { id: 'b' }] }), [{ id: 'a' }, { id: 'b' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords({ models: [{ id: 'a' }] }), [{ id: 'a' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords([{ id: 'a' }]), [{ id: 'a' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords({}), [])
    assert.deepEqual(extractOpenAICompatibleModelRecords(null), [])
  })

  it('converts a discovered record to a model-meta tagged with the instance key', () => {
    const meta = toOpenAICompatibleDiscoveredModelMeta(
      { id: 'qwen2.5-coder:7b', context_length: 32768, name: 'Qwen2.5 Coder 7B' },
      'openai-compatible:my-vllm',
      'https://host/v1/chat/completions',
    )
    assert.ok(meta)
    assert.equal(meta.modelId, 'qwen2.5-coder:7b')
    assert.equal(meta.label, 'Qwen2.5 Coder 7B')
    assert.equal(meta.providerKey, 'openai-compatible:my-vllm')
    assert.equal(meta.providerUrl, 'https://host/v1/chat/completions')
    assert.equal(meta.ctx, '32768')
    assert.equal(meta.ctxSource, 'provider-reported')
  })

  it('falls back to a synthesized label when the record has none', () => {
    const meta = toOpenAICompatibleDiscoveredModelMeta({ id: 'some_unknown-model' }, 'openai-compatible:x')
    assert.ok(meta)
    assert.equal(meta.modelId, 'some_unknown-model')
    assert.equal(meta.label, 'Some Unknown Model')
    assert.equal(meta.isEstimatedScore, true)
  })

  it('rejects records without a usable id', () => {
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({}, 'openai-compatible:x'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: '   ' }, 'openai-compatible:x'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta('', 'openai-compatible:x'), null)
  })

  it('filters non-chat models from discovered provider catalogs', () => {
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: 'nvidia/nemotron-content-safety' }, 'nvidia'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: 'text-embedding-3-large' }, 'nvidia'), null)
    assert.ok(toOpenAICompatibleDiscoveredModelMeta({ id: 'qwen/qwen3-coder' }, 'nvidia'))
  })
})


describe('passive telemetry', () => {
  const T0 = 1_700_000_000_000

  it('classifies only provider-side failures', () => {
    assert.equal(classifyFailureStatus(429), 'rateLimit')
    assert.equal(classifyFailureStatus(500), 'serverError')
    assert.equal(classifyFailureStatus(503), 'serverError')
    assert.equal(classifyFailureStatus(410), 'serverError')
    assert.equal(classifyFailureStatus(400), null)
    assert.equal(classifyFailureStatus(401), null)
    assert.equal(classifyFailureStatus(404), null)
    assert.equal(classifyFailureStatus(200), null)
  })

  it('does not penalize a model until it has enough samples', () => {
    const store = createTelemetryStore()
    for (let i = 0; i < 3; i++) recordFailure(store, 'p/m', 'serverError', { now: T0 })
    assert.equal(reliabilityMultiplier(store.models['p/m'], T0), 1)
    assert.equal(reliabilityMultiplier(undefined, T0), 1)
  })

  it('demotes a model with a poor observed success rate, floored', () => {
    const store = createTelemetryStore()
    for (let i = 0; i < 40; i++) recordFailure(store, 'p/bad', 'serverError', { now: T0 })
    for (let i = 0; i < 40; i++) recordSuccess(store, 'p/good', { now: T0 })
    const bad = reliabilityMultiplier(store.models['p/bad'], T0)
    const good = reliabilityMultiplier(store.models['p/good'], T0)
    assert.equal(bad, TELEMETRY_MIN_MULTIPLIER)
    assert.equal(good, 1)
  })

  it('never boosts above 1 and blends by success rate', () => {
    const store = createTelemetryStore()
    for (let i = 0; i < 30; i++) recordSuccess(store, 'p/m', { now: T0 })
    for (let i = 0; i < 30; i++) recordFailure(store, 'p/m', 'rateLimit', { now: T0 })
    const mult = reliabilityMultiplier(store.models['p/m'], T0)
    assert.ok(mult > 0.4 && mult < 0.6, `expected ~0.5, got ${mult}`)
  })

  it('decays old observations with the half-life', () => {
    const store = createTelemetryStore()
    for (let i = 0; i < 20; i++) recordFailure(store, 'p/m', 'network', { now: T0 })
    const fresh = getReliability(store.models['p/m'], T0)
    const aged = getReliability(store.models['p/m'], T0 + TELEMETRY_HALF_LIFE_MS)
    assert.ok(Math.abs(aged.samples - fresh.samples / 2) < 1e-9)
    const muchLater = reliabilityMultiplier(store.models['p/m'], T0 + 10 * TELEMETRY_HALF_LIFE_MS)
    assert.equal(muchLater, 1)
  })

  it('tracks ttft and tokens per second with smoothing', () => {
    const store = createTelemetryStore()
    recordSuccess(store, 'p/m', { ttftMs: 500, durationMs: 2500, completionTokens: 100, now: T0 })
    const entry = store.models['p/m']
    assert.equal(entry.ttftMs, 500)
    assert.equal(entry.tokensPerSec, 50)
    recordSuccess(store, 'p/m', { ttftMs: 1000, durationMs: 3000, completionTokens: 100, now: T0 })
    assert.ok(entry.ttftMs > 500 && entry.ttftMs < 1000)
  })

  it('ignores token rate when generation time is unusable', () => {
    const store = createTelemetryStore()
    recordSuccess(store, 'p/m', { ttftMs: 500, durationMs: 500, completionTokens: 100, now: T0 })
    assert.equal(store.models['p/m'].tokensPerSec, null)
  })

  it('ignores unknown failure kinds and empty keys', () => {
    const store = createTelemetryStore()
    recordFailure(store, 'p/m', 'bogus', { now: T0 })
    recordFailure(store, '', 'network', { now: T0 })
    recordSuccess(store, null, { now: T0 })
    assert.deepEqual(store.models, {})
  })

  it('round-trips through normalize and drops malformed entries', () => {
    const store = createTelemetryStore()
    recordSuccess(store, 'p/m', { ttftMs: 100, now: T0 })
    recordFailure(store, 'p/m', 'midstream', { now: T0 })
    const restored = normalizeTelemetryStore(JSON.parse(JSON.stringify(store)))
    assert.deepEqual(restored.models['p/m'].kinds, { midstream: 1 })
    const cleaned = normalizeTelemetryStore({ models: { a: null, b: { ok: -1, fail: 0, updatedAt: T0 }, c: { ok: 'x' } } })
    assert.deepEqual(cleaned.models, {})
    assert.deepEqual(normalizeTelemetryStore('garbage').models, {})
  })

  it('reports failure counts decayed to the same moment as samples', () => {
    const store = createTelemetryStore()
    for (let i = 0; i < 4; i++) recordFailure(store, 'p/m', 'rateLimit', { now: T0 })
    const summary = summarizeTelemetry(store, T0 + TELEMETRY_HALF_LIFE_MS)
    assert.equal(summary['p/m'].samples, 2)
    assert.equal(summary['p/m'].failures.rateLimit, 2)
  })

  it('keeps unmeasured ttft and token rate as null across a save and reload', () => {
    const store = createTelemetryStore()
    recordFailure(store, 'p/m', 'rateLimit', { now: T0 })
    const restored = normalizeTelemetryStore(JSON.parse(JSON.stringify(store)))
    assert.equal(restored.models['p/m'].ttftMs, null)
    assert.equal(restored.models['p/m'].tokensPerSec, null)
    recordSuccess(restored, 'p/m', { ttftMs: 800, durationMs: 2800, completionTokens: 100, now: T0 })
    assert.equal(restored.models['p/m'].ttftMs, 800)
    assert.equal(restored.models['p/m'].tokensPerSec, 50)
  })

  it('treats non-positive saved ttft and token rate as unmeasured', () => {
    const restored = normalizeTelemetryStore({ models: { 'p/m': { ok: 1, fail: 0, kinds: {}, updatedAt: T0, ttftMs: 0, tokensPerSec: 0 } } })
    assert.equal(restored.models['p/m'].ttftMs, null)
    assert.equal(restored.models['p/m'].tokensPerSec, null)
    const kept = normalizeTelemetryStore({ models: { 'p/m': { ok: 1, fail: 0, kinds: {}, updatedAt: T0, ttftMs: 820, tokensPerSec: 64.2 } } })
    assert.equal(kept.models['p/m'].ttftMs, 820)
    assert.equal(kept.models['p/m'].tokensPerSec, 64.2)
  })

  it('summarizes entries for the API', () => {
    const store = createTelemetryStore()
    for (let i = 0; i < 10; i++) recordSuccess(store, 'p/m', { now: T0 })
    const summary = summarizeTelemetry(store, T0)
    assert.equal(summary['p/m'].multiplier, 1)
    assert.ok(summary['p/m'].successRate > 0.9)
  })
})

describe('QoS reliability option', () => {
  const mk = (id) => ({ modelId: id, providerKey: 'p', status: 'up', pings: [{ ms: 500, code: '200', ts: Date.now() }], intell: 50 })
  it('demotes a candidate via reliabilityFor without changing default ranking', () => {
    const a = mk('a')
    const b = mk('b')
    const baseline = rankModelsForRouting([a, b])
    const demoted = rankModelsForRouting([a, b], [], { reliabilityFor: r => (r.modelId === baseline[0].modelId ? 0.25 : 1) })
    assert.equal(demoted[0].modelId, baseline[1].modelId)
  })
})


describe('isProviderRequestRejectionError', () => {
  const live = '{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"code\\":\\"400\\",\\"message\\":\\"stream error: rpc error: code = InvalidArgument desc = grammar does not compile: xgrammar StructuralTag compilation failed: unsupported schema keyword: uniqueItems\\"}}"}}}'

  it('detects the live qwen/ModelRun uniqueItems rejection', () => {
    assert.equal(isProviderRequestRejectionError(400, live), true)
  })

  it('detects other schema/tool capability rejections on 400 and 422', () => {
    assert.equal(isProviderRequestRejectionError(400, 'unsupported schema keyword: patternProperties'), true)
    assert.equal(isProviderRequestRejectionError(422, 'This model does not support tools'), true)
    assert.equal(isProviderRequestRejectionError(400, 'tool_choice is not supported for this model'), true)
    assert.equal(isProviderRequestRejectionError(400, 'Failed to compile JSON schema'), true)
  })

  it('does not treat ordinary malformed-request errors as provider rejections', () => {
    assert.equal(isProviderRequestRejectionError(400, 'Invalid request: "messages" field is required'), false)
    assert.equal(isProviderRequestRejectionError(400, '{"error":"missing required parameter model"}'), false)
    assert.equal(isProviderRequestRejectionError(400, 'max_tokens must be a positive integer'), false)
  })

  it('ignores other statuses and empty bodies', () => {
    assert.equal(isProviderRequestRejectionError(500, 'grammar does not compile'), false)
    assert.equal(isProviderRequestRejectionError(200, 'grammar does not compile'), false)
    assert.equal(isProviderRequestRejectionError(400, ''), false)
    assert.equal(isProviderRequestRejectionError(400, null), false)
  })

  it('is not mistaken for a rate limit', () => {
    assert.equal(isRateLimitShapedError(400, live), false)
  })
})


describe('isCompleteSseStream', () => {
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

  it('is complete when the stream ends with [DONE]', () => {
    assert.equal(isCompleteSseStream(`${chunk({ content: 'hi' })}data: [DONE]\n\n`), true)
  })

  it('is complete when a chunk carries a finish_reason, even without [DONE]', () => {
    assert.equal(isCompleteSseStream(`${chunk({ content: 'hi' })}${chunk({}, 'stop')}`), true)
    assert.equal(isCompleteSseStream(`${chunk({}, 'tool_calls')}`), true)
  })

  it('handles CRLF line endings', () => {
    assert.equal(isCompleteSseStream('data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'), true)
  })

  it('is incomplete when the stream stops mid-answer', () => {
    assert.equal(isCompleteSseStream(`${chunk({ role: 'assistant', content: 'partial answer' })}`), false)
    assert.equal(isCompleteSseStream(`${chunk({ content: 'a' })}${chunk({ content: 'b' })}data: {"choices":[{"delta":{"content":"tr`), false)
  })

  it('is incomplete for empty or non-string input', () => {
    assert.equal(isCompleteSseStream(''), false)
    assert.equal(isCompleteSseStream(null), false)
    assert.equal(isCompleteSseStream(undefined), false)
  })

  it('ignores comment lines and non-data events', () => {
    assert.equal(isCompleteSseStream(`: keep-alive\n\nevent: ping\n\n${chunk({ content: 'x' })}`), false)
  })
})


describe('getEffectiveContext', () => {
  it('uses the reported window when there is no observed quota', () => {
    assert.deepEqual(getEffectiveContext({ ctx: '128k' }), { tokens: 128000, reportedTokens: 128000, quotaTokens: null, capped: false, usable: true, reason: 'reported' })
  })

  it('caps the window at the observed per-minute token quota', () => {
    const info = getEffectiveContext({ ctx: '131072', rateLimit: { limitTokens: 8000 } })
    assert.equal(info.tokens, 8000)
    assert.equal(info.reportedTokens, 131072)
    assert.equal(info.capped, true)
    assert.equal(info.reason, 'quota')
  })

  it('does not cap when the quota is larger than the reported window', () => {
    const info = getEffectiveContext({ ctx: '32k', rateLimit: { limitTokens: 500000 } })
    assert.equal(info.tokens, 32000)
    assert.equal(info.capped, false)
  })

  it('is unusable when the context is only the model maximum or unknown', () => {
    const max = getEffectiveContext({ ctx: '200k', ctxSource: 'model-maximum' })
    assert.equal(max.usable, false)
    assert.equal(max.reason, 'model-maximum')
    assert.equal(max.tokens, null)
    const unknown = getEffectiveContext({ ctx: null })
    assert.equal(unknown.usable, false)
    assert.equal(unknown.reason, 'unknown')
  })

  it('ignores non-positive or non-numeric quotas', () => {
    assert.equal(getEffectiveContext({ ctx: '64k', rateLimit: { limitTokens: 0 } }).tokens, 64000)
    assert.equal(getEffectiveContext({ ctx: '64k', rateLimit: { limitTokens: '8000' } }).capped, false)
  })
})

describe('summarizeTelemetryEntry', () => {
  it('returns null when nothing has been recorded', () => {
    assert.equal(summarizeTelemetryEntry(undefined), null)
    assert.equal(summarizeTelemetryEntry(null), null)
  })

  it('matches the per-key summary used by the API', () => {
    const store = createTelemetryStore()
    const now = 1_700_000_000_000
    for (let i = 0; i < 8; i++) recordSuccess(store, 'p/m', { ttftMs: 900, durationMs: 2900, completionTokens: 100, now })
    recordFailure(store, 'p/m', 'rateLimit', { now })
    assert.deepEqual(summarizeTelemetryEntry(store.models['p/m'], now), summarizeTelemetry(store, now)['p/m'])
  })
})


describe('dashboard search and filters', () => {
  const S = globalThis.ModelRelaySearch
  const model = (overrides = {}) => ({
    label: 'Qwen 3.8 27B', providerKey: 'groq', modelId: 'qwen/qwen3.8-27b', status: 'up',
    tags: ['coding', 'general'], userTags: ['favorite'],
    ctxInfo: { usable: true, tokens: 131072 },
    ...overrides,
  })

  it('exposes the module on globalThis', () => {
    assert.equal(typeof S.parseSearch, 'function')
  })

  it('parses plain and structured terms', () => {
    const p = S.parseSearch('qwen tag:coding provider:groq status:up min_ctx:64k')
    assert.deepEqual(p.terms, ['qwen'])
    assert.deepEqual(p.tags, ['coding'])
    assert.deepEqual(p.providers, ['groq'])
    assert.deepEqual(p.statuses, ['up'])
    assert.equal(p.minCtx, 64000)
    assert.equal(p.structured, 4)
  })

  it('accepts ctx aliases and >= forms, keeping the largest', () => {
    assert.equal(S.parseSearch('ctx:32k').minCtx, 32000)
    assert.equal(S.parseSearch('ctx>=64k').minCtx, 64000)
    assert.equal(S.parseSearch('context:>=1m').minCtx, 1000000)
    assert.equal(S.parseSearch('ctx:32k min_ctx:128k').minCtx, 128000)
  })

  it('accepts comma separated tags and treats unknown keys or bad sizes as plain text', () => {
    assert.deepEqual(S.parseSearch('tag:coding,reasoning').tags, ['coding', 'reasoning'])
    assert.deepEqual(S.parseSearch('foo:bar').terms, ['foo:bar'])
    assert.deepEqual(S.parseSearch('ctx:lots').terms, ['ctx:lots'])
    assert.deepEqual(S.parseSearch('').terms, [])
    assert.deepEqual(S.parseSearch(null).terms, [])
  })

  it('matches plain terms against label, provider, id and tags, all required', () => {
    const p = (q) => S.parseSearch(q)
    assert.equal(S.matchesModel(model(), p('qwen')), true)
    assert.equal(S.matchesModel(model(), p('GROQ')), true)
    assert.equal(S.matchesModel(model(), p('favorite')), true)
    assert.equal(S.matchesModel(model(), p('qwen groq')), true)
    assert.equal(S.matchesModel(model(), p('qwen nvidia')), false)
  })

  it('filters by tag, including custom tags, and requires all tags', () => {
    const p = (q) => S.parseSearch(q)
    assert.equal(S.matchesModel(model(), p('tag:coding')), true)
    assert.equal(S.matchesModel(model(), p('tag:favorite')), true)
    assert.equal(S.matchesModel(model(), p('tag:coding,reasoning')), false)
    assert.equal(S.matchesModel(model(), p('tag:cod')), false)
  })

  it('combines filter-bar tags and min context with the search box', () => {
    const p = S.parseSearch('tag:coding')
    assert.equal(S.matchesModel(model(), p, { tags: ['general'] }), true)
    assert.equal(S.matchesModel(model(), p, { tags: ['reasoning'] }), false)
    assert.equal(S.matchesModel(model(), S.parseSearch(''), { minCtx: 128000 }), true)
    assert.equal(S.matchesModel(model(), S.parseSearch('ctx:32k'), { minCtx: 256000 }), false)
  })

  it('applies min context to the effective window and excludes unusable context', () => {
    const p = S.parseSearch('ctx:64k')
    assert.equal(S.matchesModel(model({ ctxInfo: { usable: true, tokens: 8000 } }), p), false)
    assert.equal(S.matchesModel(model({ ctxInfo: { usable: false, tokens: null } }), p), false)
    assert.equal(S.matchesModel(model({ ctxInfo: undefined }), p), false)
    assert.equal(S.matchesModel(model({ ctxInfo: { usable: false, tokens: null } }), S.parseSearch('qwen')), true)
  })

  it('filters by provider and status', () => {
    assert.equal(S.matchesModel(model(), S.parseSearch('provider:gro')), true)
    assert.equal(S.matchesModel(model(), S.parseSearch('provider:nvidia')), false)
    assert.equal(S.matchesModel(model({ status: 'down' }), S.parseSearch('status:up')), false)
    assert.equal(S.matchesModel(model({ status: 'down' }), S.parseSearch('status:down')), true)
  })

  it('formats and snaps token counts', () => {
    assert.equal(S.formatTokens(131072), '131K')
    assert.equal(S.formatTokens(1000000), '1M')
    assert.equal(S.formatTokens(8000), '8K')
    assert.equal(S.formatTokens(null), 'N/A')
    assert.equal(S.presetForTokens(131072), 128000)
    assert.equal(S.presetForTokens(8000), 8000)
    assert.equal(S.presetForTokens(4000), null)
  })

  it('counts active filters', () => {
    assert.equal(S.activeFilterCount(S.parseSearch(''), {}, 0), 0)
    assert.equal(S.activeFilterCount(S.parseSearch('qwen tag:coding'), { tags: ['fast'], minCtx: 64000 }, 2), 1 + 1 + 1 + 1 + 2)
  })

  it('round-trips UI state and rejects malformed saved state', () => {
    const state = { search: 'tag:coding', sort: { col: 'ctx', dir: 'desc' }, unchecked: { provider: ['groq'], status: ['down'] }, tags: ['fast'], minCtx: 64000 }
    assert.deepEqual(S.parseUiState(S.serializeUiState(state)), state)
    const empty = { search: '', sort: null, unchecked: {}, tags: [], minCtx: null }
    assert.deepEqual(S.parseUiState('not json'), empty)
    assert.deepEqual(S.parseUiState(null), empty)
    assert.deepEqual(S.parseUiState('{"v":99}'), empty)
    assert.equal(S.parseUiState(JSON.stringify({ v: 1, sort: { col: 'bogus', dir: 'asc' } })).sort, null)
    assert.deepEqual(S.parseUiState(JSON.stringify({ v: 1, tags: [1, 'ok'], minCtx: -5 })).tags, ['ok'])
    assert.equal(S.parseUiState(JSON.stringify({ v: 1, minCtx: -5 })).minCtx, null)
  })
})


describe('dashboard HTML escaping', () => {
  // Load the dashboard's real escapeHtml (it lives in the page's inline script) and exercise it.
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')
  const source = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n    \}/)
  const escapeHtml = new Function(`${source[0]}; return escapeHtml`)()

  it('escapes quotes so values cannot break out of an attribute', () => {
    const hostile = 'x" onmouseover="alert(1)" y=\'z'
    const escaped = escapeHtml(hostile)
    assert.equal(escaped.includes('"'), false)
    assert.equal(escaped.includes("'"), false)
    assert.equal(escaped, 'x&quot; onmouseover=&quot;alert(1)&quot; y=&#39;z')
  })

  it('still escapes markup and ampersands, and handles non-strings', () => {
    assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;')
    assert.equal(escapeHtml(null), 'null')
    assert.equal(escapeHtml(42), '42')
  })

  it('escapes & first so entities are not double-decoded into markup', () => {
    assert.equal(escapeHtml('&quot;'), '&amp;quot;')
  })

  it('renders numeric data attributes through Number() so they cannot carry markup', () => {
    assert.ok(html.includes('data-ctx="${Number(info.tokens) || 0}"'))
    assert.equal(html.includes('data-ctx="${info.tokens}"'), false)
  })
})

describe('normalizeRequestedModel', () => {
  it('keeps normal selectors and caps hostile or huge input', () => {
    assert.equal(normalizeRequestedModel('auto-fastest+min_ctx:32000'), 'auto-fastest+min_ctx:32000')
    assert.equal(normalizeRequestedModel('x'.repeat(5000)).length, MAX_REQUESTED_MODEL_LENGTH)
  })

  it('returns null for missing or non-string models', () => {
    assert.equal(normalizeRequestedModel(undefined), null)
    assert.equal(normalizeRequestedModel(null), null)
    assert.equal(normalizeRequestedModel(''), null)
    assert.equal(normalizeRequestedModel({ model: 'x' }), null)
    assert.equal(normalizeRequestedModel(42), null)
  })
})


describe('dashboard inline handler and markup safety', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')
  const fnSource = (name) => new Function(`${html.match(new RegExp(`function ${name}\\(value\\) \\{[\\s\\S]*?\\n    \\}`))[0]}; return ${name}`)()
  const escapeHtml = fnSource('escapeHtml')
  const jsArg = new Function('escapeHtml', `${html.match(/function jsArg\(value\) \{[\s\S]*?\n    \}/)[0]}; return jsArg`)(escapeHtml)
  const decodeEntities = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

  // What the browser does with onclick="fn(...)": decode the attribute, then run it as JS.
  const roundTrip = (value) => {
    let received
    const attr = `capture(${jsArg(value)})`
    new Function('capture', decodeEntities(attr))((v) => { received = v })
    return received
  }

  it('jsArg hands the exact original string to the handler, whatever it contains', () => {
    const hostile = [
      "it's'),window.__pwn=2,('",
      'evil"><img src=x onerror=window.__pwn=1>',
      'q" data-pwn="1',
      '</script><script>alert(1)</script>',
      'back\\slash and \\u0041 and "quotes" and \'single\'',
      'line1\nline2\r\n\ttab',
      '&quot; &amp; &#39; &lt;b&gt;',
      'unicode \u2028 \u2029 \u00e9 \ud83d\ude80',
      '',
      'plain-model-id',
    ]
    for (const value of hostile) assert.equal(roundTrip(value), value, `round trip failed for ${JSON.stringify(value)}`)
    assert.equal(roundTrip(null), '')
    assert.equal(roundTrip(undefined), '')
    assert.equal(roundTrip(42), '42')
  })

  it('jsArg output contains no raw quote that could end the attribute', () => {
    const out = jsArg('x" onmouseover="alert(1)\' y')
    assert.equal(out.includes('"'), false)
    assert.equal(out.includes("'"), false)
  })

  const handlerAttrs = [...html.matchAll(/\bon[a-z]+\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/g)]
    .map(m => ({ quote: m[1] !== undefined ? '"' : "'", body: m[1] !== undefined ? m[1] : m[2] }))
    .filter(a => a.body.includes('${'))

  it('finds the inline handlers with interpolation (guards the scan itself)', () => {
    assert.ok(handlerAttrs.length >= 25, `expected at least 25, found ${handlerAttrs.length}`)
  })

  it('every handler interpolation goes through jsArg or is a plain loop index', () => {
    for (const { body } of handlerAttrs) {
      const exprs = [...body.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map(m => m[1].trim())
      for (const expr of exprs) {
        assert.ok(/^jsArg\(/.test(expr) || /^(i|idx)$/.test(expr), `unsafe interpolation in handler: ${body.slice(0, 120)}`)
      }
    }
  })

  it('no handler wraps an interpolation in quotes, embeds JSON, or uses a single-quoted attribute', () => {
    for (const { quote, body } of handlerAttrs) {
      assert.equal(quote, '"', `single-quoted handler: ${body.slice(0, 80)}`)
      assert.equal(/'\$\{/.test(body), false, `quote-wrapped interpolation: ${body.slice(0, 80)}`)
      assert.equal(body.includes('JSON.stringify'), false, `JSON in handler: ${body.slice(0, 80)}`)
    }
  })

  it('opens drawers by row key instead of embedding the whole model in onclick', () => {
    assert.equal(html.includes('openDrawer(${JSON.stringify'), false)
    assert.ok(html.includes('function openDrawerByRow(rowKey)'))
  })

  it('does not interpolate untrusted fields into markup unescaped', () => {
    for (const raw of ['${p.key}', '${m.label}</div>', '${p.name}</h3>', '${l.model}</span>', '<span>${l.provider}</span>', '${m.modelId}</div>', 'href="${p.signupUrl}"']) {
      assert.equal(html.includes(raw), false, `raw interpolation present: ${raw}`)
    }
  })
})


describe('linear-time text helpers', () => {
  it('trims either or both ends by predicate', () => {
    const dash = (ch) => ch === '-'
    assert.equal(trimStartWhile('--a-b--', dash), 'a-b--')
    assert.equal(trimEndWhile('--a-b--', dash), '--a-b')
    assert.equal(trimWhile('--a-b--', dash), 'a-b')
    assert.equal(trimWhile('----', dash), '')
    assert.equal(trimWhile('', dash), '')
    assert.equal(trimWhile('abc', dash), 'abc')
  })

  it('strips runs of trailing suffixes case-insensitively', () => {
    const suffixes = [':free', ':optimized', ':cloud']
    assert.equal(stripTrailingSuffixes('model:free', suffixes), 'model')
    assert.equal(stripTrailingSuffixes('model:optimized:free', suffixes), 'model')
    assert.equal(stripTrailingSuffixes('model:FREE:Cloud', suffixes), 'model')
    assert.equal(stripTrailingSuffixes('model:free:x', suffixes), 'model:free:x')
    assert.equal(stripTrailingSuffixes('free', suffixes), 'free')
    assert.equal(stripTrailingSuffixes(':free', suffixes), '')
    assert.equal(stripTrailingSuffixes('', suffixes), '')
  })

  it('caps length and recognises unsafe object keys', () => {
    assert.equal(capLength('abcdef', 3), 'abc')
    assert.equal(capLength('ab', 3), 'ab')
    for (const key of ['__proto__', 'constructor', 'prototype', '', 'x'.repeat(201), 42, null, undefined, {}]) assert.equal(isSafeObjectKey(key), false, String(key))
    for (const key of ['nvidia', 'openai-compatible:my-vllm', 'a_b', 'proto', '__proto']) assert.equal(isSafeObjectKey(key), true, key)
  })
})

describe('regex replacements keep their exact behavior', () => {
  // Deterministic pseudo-random strings built from the characters these functions care about.
  const pieces = ['a', 'b', 'x', '-', '--', '_', ' ', '\t', '\n', ':', ':free', ':FREE', ':cloud', ':optimized', 'free', '\u2588', '\u2580', '\u259f', '.', '/']
  let seed = 12345
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const corpus = Array.from({ length: 4000 }, () => Array.from({ length: rand(14) }, () => pieces[rand(pieces.length)]).join(''))

  it('canonicalizeModelId strips trailing :free/:optimized/:cloud runs exactly like the old regex', () => {
    const old = (s) => s.replace(/(?::(?:free|optimized|cloud))+$/i, '')
    for (const s of corpus) assert.equal(stripTrailingSuffixes(s, [':free', ':optimized', ':cloud']), old(s), JSON.stringify(s))
  })

  it('normalizeTag matches the old regex chain', () => {
    const old = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32)
    for (const s of corpus) assert.equal(normalizeTag(s), old(s), JSON.stringify(s))
    assert.equal(normalizeTag(null), '')
    assert.equal(normalizeTag('  --My Tag_-- '), 'my-tag')
  })

  it('OpenAI-compatible instance keys match the old regex chain', () => {
    const old = (id) => { const t = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); return t ? `openai-compatible:${t}` : null }
    for (const s of corpus) assert.equal(buildInstanceKeyForSafetyTests(s), old(s), JSON.stringify(s))
    assert.equal(buildInstanceKeyForSafetyTests('  --My Endpoint!! '), 'openai-compatible:my-endpoint')
    assert.equal(buildInstanceKeyForSafetyTests('!!!'), null)
  })

  it('normalizeSecret drops trailing whitespace and block characters like the old regex', () => {
    const old = (v) => typeof v === 'string' ? v.replace(/[\s\u2580-\u259F]+$/g, '').trim() : ''
    for (const s of corpus) assert.equal(normalizeSecret(s), old(s), JSON.stringify(s))
    assert.equal(normalizeSecret('sk-123 \u2588\u2588\t\n'), 'sk-123')
    assert.equal(normalizeSecret(42), '')
  })
})

describe('adversarial input cannot stall the router', () => {
  // Each of these took minutes (quadratic) with the old regexes. Linear code finishes in milliseconds; the
  // generous bound keeps the test stable on slow CI while still failing loudly on a regression.
  const timed = (fn) => { const start = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - start) / 1e6 }
  const N = 2_000_000

  it('model id with a huge run of :free', () => {
    assert.ok(timed(() => stripTrailingSuffixes(':free'.repeat(N / 5) + 'x', [':free', ':optimized', ':cloud'])) < 1000)
  })
  it('endpoint name with a huge run of dashes', () => {
    assert.ok(timed(() => buildInstanceKeyForSafetyTests('x' + '-'.repeat(N) + 'x')) < 1000)
  })
  it('tag with a huge run of dashes and underscores', () => {
    assert.ok(timed(() => normalizeTag('x' + '-_'.repeat(N / 2) + 'x')) < 1000)
  })
  it('API key with a huge run of whitespace', () => {
    assert.ok(timed(() => normalizeSecret('\t'.repeat(N) + 'x')) < 1000)
  })
  it('display labels are capped before the trailing-anchored regexes run', () => {
    assert.ok(timed(() => cleanModelDisplayLabelForSafetyTests(' '.repeat(N) + 'x')) < 1000)
    assert.ok(timed(() => cleanModelDisplayLabelForSafetyTests(' ('.repeat(N / 2))) < 1000)
  })
})

describe('prototype pollution guards', () => {
  const polluted = () => Object.keys(Object.prototype)

  it('isKnownProviderKey accepts real providers and rejects prototype keys', () => {
    for (const key of ['nvidia', 'groq', 'kiro', 'openai-compatible', 'openai-compatible:my-vllm']) assert.equal(isKnownProviderKey(key, {}), true, key)
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'nope', '', null, undefined, 42, {}, 'openai-compatible:../x', 'openai-compatible:a b', 'openai-compatible:']) assert.equal(isKnownProviderKey(key, {}), false, String(key))
  })

  it('isKnownProviderKey honours providers already in the saved config, own properties only', () => {
    assert.equal(isKnownProviderKey('legacy', { providers: { legacy: {} } }), true)
    assert.equal(isKnownProviderKey('legacy', { providers: {} }), false)
    assert.equal(isKnownProviderKey('toString', { providers: {} }), false)
    assert.equal(isKnownProviderKey('__proto__', JSON.parse('{"providers":{"__proto__":{"polluted":true}}}')), false)
  })

  it('model id alias lookup returns strings for prototype member names', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(resolveAliasedModelId(id), id)
      assert.equal(typeof canonicalizeModelId(id).base, 'string')
    }
    assert.equal(resolveAliasedModelId('deepseek-v3.2'), 'deepseek-ai/deepseek-v3.2')
  })

  it('setModelTags refuses prototype keys and leaves Object.prototype alone', () => {
    const config = {}
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      const result = setModelTags(config, id, ['evil'])
      assert.deepEqual(result.tags, [])
    }
    assert.equal(({}).evil, undefined)
    assert.deepEqual(polluted(), [])
    assert.deepEqual(Object.keys(config.modelTags), [])
    assert.deepEqual(setModelTags(config, 'nvidia/some-model', ['ok']).tags, ['ok'])
  })

  it('normalizeConfigShape drops __proto__ model tag keys from an imported config', () => {
    const hostile = JSON.parse('{"modelTags":{"__proto__":["evil"],"real-model":["good"]}}')
    const shaped = normalizeConfigShape(hostile)
    assert.equal(Object.getPrototypeOf(shaped.modelTags), Object.prototype)
    assert.equal(shaped.modelTags.evil, undefined)
    assert.deepEqual(shaped.modelTags['real-model'], ['good'])
    assert.deepEqual(polluted(), [])
  })
})


describe('admin guard: host header', () => {
  it('parses host headers with ports, IPv6 and bad input', () => {
    assert.deepEqual(parseHostHeader('Localhost:7352'), { host: 'localhost', port: '7352' })
    assert.deepEqual(parseHostHeader('example.com'), { host: 'example.com', port: '' })
    assert.deepEqual(parseHostHeader('[::1]:7352'), { host: '::1', port: '7352' })
    assert.deepEqual(parseHostHeader('192.168.1.5:80'), { host: '192.168.1.5', port: '80' })
    for (const bad of ['', '  ', 'a b', 'host:abc', 'host:99999999', '[::1', '[nope]:80', 'ex ample.com', 'a'.repeat(300), null, undefined, 42]) assert.equal(parseHostHeader(bad), null, String(bad))
  })

  it('parses allow lists', () => {
    assert.deepEqual(parseAllowedHosts(' Dash.Example.com , other.example:7352,* '), ['dash.example.com', 'other.example', '*'])
    assert.deepEqual(parseAllowedHosts(''), [])
    assert.deepEqual(parseAllowedHosts(undefined), [])
    assert.deepEqual(parseAllowedOrigins('https://a.example.com, http://b.example:8080/path, nonsense'), ['https://a.example.com', 'http://b.example:8080'])
  })

  it('allows IP literals, localhost, this machine and listed hosts only', () => {
    const opts = { extraHosts: ['dash.example.com'], machineName: 'MyBox' }
    for (const host of ['localhost:7352', 'LOCALHOST', 'app.localhost:7352', '127.0.0.1:7352', '[::1]:7352', '192.168.1.5', '10.0.0.7:7352', 'mybox', 'mybox:7352', 'mybox.local:7352', 'dash.example.com', 'dash.example.com:443']) {
      assert.equal(isAllowedHost(host, opts), true, host)
    }
    for (const host of ['evil.example.com', 'localhost.evil.com', 'dash.example.com.evil.net', 'xdash.example.com', 'mybox.evil.com', 'attacker.com:7352', 'a b', '']) {
      assert.equal(isAllowedHost(host, opts), false, host)
    }
    assert.equal(isAllowedHost('anything.example.org', { extraHosts: ['*'] }), true)
    assert.equal(isAllowedHost(undefined, opts), true)
  })
})

describe('admin guard: origin and fetch metadata', () => {
  const host = 'localhost:7352'
  it('allows same-origin requests and requests without an Origin', () => {
    assert.equal(evaluateRequestOrigin({ origin: 'http://localhost:7352', host }).ok, true)
    assert.equal(evaluateRequestOrigin({ origin: undefined, host }).ok, true)
    assert.equal(evaluateRequestOrigin({ origin: undefined, host, secFetchSite: 'same-origin' }).ok, true)
    assert.equal(evaluateRequestOrigin({ origin: undefined, host, secFetchSite: 'none' }).ok, true)
  })
  it('blocks other origins, opaque origins and cross-site fetches', () => {
    for (const origin of ['http://127.0.0.1:8099', 'https://evil.example', 'http://localhost:3000', 'http://localhost', 'null', 'not a url']) {
      assert.equal(evaluateRequestOrigin({ origin, host }).ok, false, origin)
    }
    for (const site of ['cross-site', 'same-site']) assert.equal(evaluateRequestOrigin({ origin: undefined, host, secFetchSite: site }).ok, false, site)
  })
  it('honours MODELRELAY_ALLOWED_ORIGINS for reverse proxies', () => {
    assert.equal(evaluateRequestOrigin({ origin: 'https://proxy.example.com', host: 'modelrelay:7352', allowedOrigins: ['https://proxy.example.com'] }).ok, true)
    assert.equal(evaluateRequestOrigin({ origin: 'https://other.example.com', host: 'modelrelay:7352', allowedOrigins: ['https://proxy.example.com'] }).ok, false)
  })
})

describe('admin guard: token and sessions', () => {
  it('verifies the token in constant time and rejects anything else', () => {
    const auth = createAdminAuth({ token: 'correct-horse-battery-staple' })
    assert.equal(auth.enabled, true)
    assert.equal(auth.verifyToken('correct-horse-battery-staple'), true)
    for (const bad of ['', 'wrong', 'correct-horse-battery-stapl', 'correct-horse-battery-staple ', null, undefined, 42, {}]) assert.equal(auth.verifyToken(bad), false, String(bad))
    assert.equal(createAdminAuth({ token: '' }).enabled, false)
    assert.equal(createAdminAuth({}).enabled, false)
    assert.equal(createAdminAuth({ token: '' }).verifyToken(''), false)
  })

  it('creates sessions that expire and can be destroyed', () => {
    let clock = 1_000
    const auth = createAdminAuth({ token: 't'.repeat(20), sessionTtlMs: 5_000, now: () => clock })
    const id = auth.createSession()
    assert.match(id, /^[0-9a-f]{64}$/)
    assert.equal(auth.isValidSession(id), true)
    assert.equal(auth.isValidSession('nope'), false)
    clock += 4_999
    assert.equal(auth.isValidSession(id), true)
    clock += 2
    assert.equal(auth.isValidSession(id), false)
    const id2 = auth.createSession()
    auth.destroySession(id2)
    assert.equal(auth.isValidSession(id2), false)
  })

  it('caps the number of live sessions', () => {
    const auth = createAdminAuth({ token: 't'.repeat(20) })
    const first = auth.createSession()
    for (let i = 0; i < 150; i++) auth.createSession()
    assert.ok(auth.sessionCount() <= 100)
    assert.equal(auth.isValidSession(first), false)
  })

  it('locks a client out after repeated failures, and clears on success', () => {
    let clock = 0
    const auth = createAdminAuth({ token: 't'.repeat(20), now: () => clock })
    for (let i = 0; i < 9; i++) auth.recordFailure('1.2.3.4')
    assert.equal(auth.isLockedOut('1.2.3.4'), false)
    auth.recordFailure('1.2.3.4')
    assert.equal(auth.isLockedOut('1.2.3.4'), true)
    assert.equal(auth.isLockedOut('5.6.7.8'), false)
    clock += 16 * 60 * 1000
    assert.equal(auth.isLockedOut('1.2.3.4'), false)
    auth.recordFailure('9.9.9.9'); auth.clearFailures('9.9.9.9')
    assert.equal(auth.isLockedOut('9.9.9.9'), false)
  })

  it('parses cookies and builds session cookies', () => {
    assert.deepEqual(parseCookies('a=1; modelrelay_session=abc; b=2'), { a: '1', modelrelay_session: 'abc', b: '2' })
    assert.deepEqual(parseCookies(undefined), {})
    assert.equal(parseCookies('a=1; a=2').a, '1')
    const cookie = buildSessionCookie('abc')
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`))
    assert.match(buildSessionCookie('abc', { secure: true }), /; Secure$/)
    assert.match(buildClearedCookie(), /Max-Age=0/)
  })
})

describe('admin guard: end to end over HTTP', () => {
  const TOKEN = 'correct-horse-battery-staple'
  let server, port

  // Node's fetch will not let a test set the Host header, so use http.request.
  const call = (options) => new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = http.request({ host: '127.0.0.1', port, method: options.method || 'GET', path: options.path || '/api/secret',
      headers: { host: `localhost:${port}`, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) } }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => { let json = null; try { json = JSON.parse(data) } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json }) })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
  const login = async (token = TOKEN) => call({ method: 'POST', path: '/api/auth/login', body: { token } })
  const cookieOf = (res) => String(res.headers['set-cookie'] || '').split(';')[0]

  before(async () => {
    const auth = createAdminAuth({ token: TOKEN })
    const guard = createAdminMiddleware({ auth, extraHosts: ['dash.example.com'], allowedOrigins: ['https://proxy.example.com'], machineName: 'mybox' })
    const routes = createAuthRoutes({ auth })
    const app = express()
    app.use('/api', guard)
    app.use('/api', express.json())
    app.get('/api/auth/status', routes.status)
    app.post('/api/auth/login', routes.login)
    app.post('/api/auth/logout', routes.logout)
    app.get('/api/secret', (req, res) => res.json({ secret: 'the keys' }))
    app.get('/v1/open', (req, res) => res.json({ open: true }))
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
    port = server.address().port
  })
  after(() => new Promise(resolve => server.close(resolve)))

  it('rejects an unexpected Host before anything else (DNS rebinding)', async () => {
    const res = await call({ headers: { host: 'evil.example.com' } })
    assert.equal(res.status, 403)
    assert.match(res.json.error, /not allowed/)
    assert.match(res.json.hint, /MODELRELAY_ALLOWED_HOSTS/)
    assert.equal((await call({ headers: { host: `dash.example.com:${port}` } })).status, 401) // allowed host, but no login yet
  })

  it('blocks cross-origin browser requests even for simple requests', async () => {
    const attacker = await call({ headers: { origin: 'http://127.0.0.1:8099' } })
    assert.equal(attacker.status, 403)
    assert.match(attacker.json.error, /Cross-origin/)
    assert.equal((await call({ headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal((await call({ method: 'POST', path: '/api/auth/login', headers: { origin: 'http://evil.example' }, body: { token: TOKEN } })).status, 403)
    assert.equal((await call({ headers: { origin: 'https://proxy.example.com', host: 'mybox' } })).status, 401) // allowed origin, then auth
  })

  it('never lets admin responses be cached', async () => {
    assert.equal((await call({})).headers['cache-control'], 'no-store')
  })

  it('requires sign-in for admin routes but leaves /api/auth open', async () => {
    const denied = await call({})
    assert.equal(denied.status, 401)
    assert.equal(denied.json.authRequired, true)
    const status = await call({ path: '/api/auth/status' })
    assert.deepEqual(status.json, { authRequired: true, authenticated: false })
  })

  it('signs in with the token, then serves admin routes using the session cookie', async () => {
    const bad = await login('wrong-token')
    assert.equal(bad.status, 401)
    assert.equal(bad.headers['set-cookie'], undefined)
    const ok = await login()
    assert.equal(ok.status, 200)
    const setCookie = String(ok.headers['set-cookie'])
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    assert.equal(/Secure/.test(setCookie), false) // plain http
    const cookie = cookieOf(ok)
    const secret = await call({ headers: { cookie } })
    assert.equal(secret.status, 200)
    assert.deepEqual(secret.json, { secret: 'the keys' })
    assert.deepEqual((await call({ path: '/api/auth/status', headers: { cookie } })).json, { authRequired: true, authenticated: true })
    // signing out ends the session
    await call({ method: 'POST', path: '/api/auth/logout', headers: { cookie } })
    assert.equal((await call({ headers: { cookie } })).status, 401)
  })

  it('marks the cookie Secure when the request came in over https', async () => {
    const ok = await call({ method: 'POST', path: '/api/auth/login', headers: { 'x-forwarded-proto': 'https' }, body: { token: TOKEN } })
    assert.match(String(ok.headers['set-cookie']), /; Secure/)
  })

  it('accepts the token as a Bearer header for scripts', async () => {
    assert.equal((await call({ headers: { authorization: `Bearer ${TOKEN}` } })).status, 200)
    assert.equal((await call({ headers: { authorization: 'Bearer nope' } })).status, 401)
    assert.equal((await call({ headers: { authorization: TOKEN } })).status, 401)
  })

  it('does not accept a made-up session cookie', async () => {
    assert.equal((await call({ headers: { cookie: `${SESSION_COOKIE}=${'0'.repeat(64)}` } })).status, 401)
  })

  it('leaves the /v1 proxy outside the guard', async () => {
    const res = await call({ path: '/v1/open', headers: { host: 'evil.example.com', origin: 'https://evil.example' } })
    assert.equal(res.status, 200)
  })

  it('stops brute force guessing with a lockout', async () => {
    let status = 0
    for (let i = 0; i < 12; i++) status = (await login('guess-' + i)).status
    assert.equal(status, 429)
    assert.equal((await login()).status, 429) // even the right token is refused while locked out
  })
})

describe('admin guard with no token configured', () => {
  it('still enforces host and origin but needs no sign-in', async () => {
    const auth = createAdminAuth({ token: '' })
    const guard = createAdminMiddleware({ auth })
    const routes = createAuthRoutes({ auth })
    const app = express()
    app.use('/api', guard)
    app.use('/api', express.json())
    app.get('/api/auth/status', routes.status)
    app.get('/api/secret', (req, res) => res.json({ ok: true }))
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const port = server.address().port
    const get = (headers = {}) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/secret', headers: { host: `localhost:${port}`, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) }).on('error', reject)
    })
    try {
      assert.equal(await get(), 200)
      assert.equal(await get({ host: 'evil.example.com' }), 403)
      assert.equal(await get({ origin: 'http://evil.example' }), 403)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
