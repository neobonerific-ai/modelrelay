/**
 * @file lib/utils.js
 * @description Pure utility functions for scoring and CLI parsing.
 */

import { MODELS, cleanModelDisplayLabel, getPreferredModelLabel, resolveAliasedModelId } from '../sources.js'
import { getModelTags as getBuiltInModelTags } from '../tags.js'

export const VERDICT_ORDER = ['Perfect', 'Normal', 'Slow', 'Very Slow', 'Overloaded', 'Unstable', 'Not Active', 'Pending']

export const DEFAULT_PING_WINDOW_MS = 35 * 60 * 1000

// Reference latency (ms) for QoS scoring. A model averaging this speed keeps its full
// quality-driven score; slower models are discounted continuously by latencyScore() below.
// Overridable per deployment via the `qosLatencyTargetMs` config setting (see config.js /
// the Settings tab), same pattern as the existing minSweScore filter.
export const DEFAULT_QOS_LATENCY_TARGET_MS = 3000

const QOS_REFERENCE_INTELL = MODELS
  .map(m => Number(m[2]))
  .filter(v => Number.isFinite(v) && v > 0)

export const getAvg = (r, windowMs = DEFAULT_PING_WINDOW_MS) => {
  const now = Date.now()
  const successfulPings = (r.pings || [])
    .filter(p => p.code === '200' && (p.ts == null || now - p.ts <= windowMs))
  if (successfulPings.length === 0) return Infinity
  return Math.round(successfulPings.reduce((a, b) => a + b.ms, 0) / successfulPings.length)
}

export const getVerdict = (r) => {
  const avg = getAvg(r)
  const wasUpBefore = r.pings.length > 0 && r.pings.some(p => p.code === '200')

  if (r.httpCode === '429') return 'Overloaded'
  if ((r.status === 'timeout' || r.status === 'down') && wasUpBefore) return 'Unstable'
  if (r.status === 'timeout' || r.status === 'down') return 'Not Active'
  if (avg === Infinity) return 'Pending'
  if (avg < 400) return 'Perfect'
  if (avg < 1000) return 'Normal'
  if (avg < 3000) return 'Slow'
  if (avg < 5000) return 'Very Slow'
  if (avg < 10000) return 'Unstable'
  return 'Unstable'
}

export const getUptime = (r) => {
  if (r.pings.length === 0) return 0
  const successful = r.pings.filter(p => p.code === '200').length
  return Math.round((successful / r.pings.length) * 100)
}

export const sortResults = (results, sortColumn, sortDirection) => {
  return [...results].sort((a, b) => {
    let cmp = 0

    switch (sortColumn) {
      case 'rank':
        cmp = a.idx - b.idx
        break
      case 'model':
        cmp = (a.label || '').localeCompare(b.label || '')
        break
      case 'intell':
        cmp = (a.intell || 0) - (b.intell || 0)
        break
      case 'avg':
        cmp = getAvg(a) - getAvg(b)
        break
      case 'ctx': {
        const parseCtx = (ctx) => {
          if (!ctx || ctx === '—') return 0
          const str = ctx.toLowerCase()
          if (str.includes('m')) {
            const num = parseFloat(str.replace('m', ''))
            return num * 1000
          }
          if (str.includes('k')) {
            const num = parseFloat(str.replace('k', ''))
            return num
          }
          return 0
        }
        cmp = parseCtx(a.ctx) - parseCtx(b.ctx)
        break
      }
      case 'condition':
        cmp = a.status.localeCompare(b.status)
        break
      case 'verdict': {
        const aVerdict = getVerdict(a)
        const bVerdict = getVerdict(b)
        cmp = VERDICT_ORDER.indexOf(aVerdict) - VERDICT_ORDER.indexOf(bVerdict)
        break
      }
      case 'uptime':
        cmp = getUptime(a) - getUptime(b)
        break
    }

    return sortDirection === 'asc' ? cmp : -cmp
  })
}

function toValidPositiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function percentileRank(values, target) {
  const n = values.length
  if (n === 0 || target == null) return null
  if (n === 1) return 100

  let lt = 0
  let eq = 0
  for (const v of values) {
    if (v < target) lt += 1
    else if (v === target) eq += 1
  }

  const rank01 = (lt + (0.5 * eq)) / n
  return rank01 * 100
}

function availabilityMultiplierForUptime(uptime) {
  if (uptime >= 95) return 1.0
  if (uptime >= 85) return 0.9
  if (uptime >= 70) return 0.6
  return 0.2
}

/**
 * Continuous, monotonic latency discount in (0, 1]. Never fully saturates the way the old
 * `Math.max(0, 1000 - ping) / 1000` tiebreaker did: that expression hit exactly 0 once avg
 * ping crossed 1000ms and stayed there, so a model averaging 1.1s and one averaging 291s
 * (a real incident -- nvidia/z-ai/glm-5.2 sat at a 200-290s avg for ~24h) scored identically
 * on latency. This keeps differentiating at every scale: a 100ms and an 800ms model are
 * still meaningfully separated, and a 250s model is discounted toward zero instead of being
 * treated as equivalent to a fast one, as long as it's technically still "up" (HTTP 200).
 * Unpinged/no-data models (avg === Infinity) get the neutral midpoint (target vs target).
 */
export function latencyScore(avgMs, targetMs = DEFAULT_QOS_LATENCY_TARGET_MS) {
  const effectiveAvg = (avgMs === Infinity || avgMs == null) ? targetMs : avgMs
  return targetMs / (targetMs + effectiveAvg)
}

function computeQoSFromNormalizedScores(r, normalizedScores, latencyTargetMs) {
  if (r.status !== 'up') return 0
  const qualityScore = normalizedScores.gpqa != null ? normalizedScores.gpqa : 0

  const speed = latencyScore(getAvg(r), latencyTargetMs)
  const uptime = getUptime(r)
  // speed multiplies the quality-driven score (so catastrophic latency suppresses even a
  // top-quality model, not just nudges it) and is also added on its own so equally- or
  // un-rated candidates still rank by speed alone.
  const availabilityScore = qualityScore * availabilityMultiplierForUptime(uptime) * speed
  return availabilityScore + speed
}

export function computeQoSMap(results, excludedModelIds = [], { latencyTargetMs = DEFAULT_QOS_LATENCY_TARGET_MS, reliabilityFor = null, unratedQualityFloor = 0 } = {}) {
  const excluded = new Set(excludedModelIds)
  const eligible = results.filter(r => isModelEligibleForRouting(r) && !excluded.has(r.modelId))

  const qosMap = new Map()
  for (const r of eligible) {
    const intellNorm = percentileRank(QOS_REFERENCE_INTELL, toValidPositiveNumber(r.intell))
    // A model with no benchmark data scores a percentile of 0, which puts it behind every rated
    // model no matter how fast or how good it is. "Unknown" is not "worst": with a floor set, an
    // unrated model is ranked as an unknown instead of as a failure, and still has to beat the
    // rated models on speed and uptime.
    const quality = intellNorm == null && unratedQualityFloor > 0 ? unratedQualityFloor : intellNorm
    let qos = computeQoSFromNormalizedScores(r, { gpqa: quality }, latencyTargetMs)
    // Observed real-traffic reliability in [0, 1]; a model that keeps failing real requests is
    // demoted even if its synthetic pings look healthy.
    if (typeof reliabilityFor === 'function') {
      const multiplier = Number(reliabilityFor(r))
      if (Number.isFinite(multiplier)) qos *= Math.min(1, Math.max(0, multiplier))
    }
    qosMap.set(r, qos)
  }

  return qosMap
}

export function computeQoS(r, latencyTargetMs) {
  const qosMap = computeQoSMap([r], [], { latencyTargetMs })
  return qosMap.get(r) || 0
}

export function isModelEligibleForRouting(r) {
  // 'unsupported' means the model exists but cannot be used from here (e.g. the
  // OpenCode Zen free models without the free-tier compatibility mode). It is
  // not a failure, so it must not be routed to.
  return r.status !== 'banned' && r.status !== 'disabled' && r.status !== 'excluded' && r.status !== 'unsupported'
}

export function getRoutingModelKey(r) {
  const provider = normalizeModelAlias(r?.providerKey)
  const model = normalizeModelAlias(r?.modelId)
  return provider ? `${provider}/${model}` : model
}

function normalizeExcludedModelKeys(excludedModelIds = []) {
  return new Set(excludedModelIds.map(value => normalizeModelAlias(value)))
}

function isRoutingModelExcluded(r, excluded) {
  return excluded.has(normalizeModelAlias(r?.modelId)) || excluded.has(getRoutingModelKey(r))
}

export function rankModelsForRouting(results, excludedModelIds = [], options = {}) {
  const excluded = normalizeExcludedModelKeys(excludedModelIds)
  const eligible = results.filter(r => isModelEligibleForRouting(r) && !isRoutingModelExcluded(r, excluded))
  const qosMap = computeQoSMap(eligible, [], options)
  const scored = eligible.map(r => ({ r, qos: qosMap.get(r) || 0 }))
  scored.sort((a, b) => b.qos - a.qos)
  return scored.map(s => s.r)
}

export function findBestModel(results, options = {}) {
  const ranked = rankModelsForRouting(results, [], options)
  return ranked[0] || null
}

function ensureKeyPoolAccount(entry, idx) {
  if (!entry.accounts.has(idx)) {
    entry.accounts.set(idx, { requests: 0, rateLimitedAt: 0 })
  }
  return entry.accounts.get(idx)
}

export function selectNextApiKeyFromPool(pool, entry, maxTurns, now, cooldownMs) {
  if (!Array.isArray(pool) || pool.length === 0) return null
  if (!entry || !(entry.accounts instanceof Map)) return null

  const isRateLimited = idx => {
    const acct = entry.accounts.get(idx)
    return !!(acct && acct.rateLimitedAt && (now - acct.rateLimitedAt) < cooldownMs)
  }

  const trySelect = (respectMaxTurns) => {
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const idx = entry.currentIdx % pool.length
      const acct = entry.accounts.get(idx)
      const keyRateLimited = isRateLimited(idx)
      const hitMaxTurns = respectMaxTurns && maxTurns > 0 && acct && acct.requests >= maxTurns

      if (!keyRateLimited && !hitMaxTurns) {
        const selectedAccount = ensureKeyPoolAccount(entry, idx)
        selectedAccount.requests++
        entry.currentIdx = (idx + 1) % pool.length
        return pool[idx]
      }

      entry.currentIdx = (idx + 1) % pool.length
    }

    return null
  }

  const selected = trySelect(true)
  if (selected) return selected

  const hasNonRateLimitedKey = pool.some((_, idx) => !isRateLimited(idx))
  if (!hasNonRateLimitedKey) return null

  for (const [, acct] of entry.accounts) {
    acct.requests = 0
  }
  entry.currentIdx = 0

  return trySelect(false)
}

function normalizeModelAlias(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function normalizeModelLabel(label) {
  if (typeof label !== 'string') return ''
  return cleanModelDisplayLabel(label)
    .replace(/\s+\([^)]*\)\s*$/g, '')
    .toLowerCase()
}

function toDisplayModelLabel(label, fallback) {
  if (typeof label === 'string' && label.trim()) {
    const cleaned = cleanModelDisplayLabel(label).replace(/\s+\([^)]*\)\s*$/g, '')
    if (cleaned) return cleaned
  }
  return fallback
}

function getExactModelCounts(results) {
  const counts = new Map()
  for (const r of results) {
    const key = normalizeModelAlias(r?.modelId)
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function hasDuplicateExactModelId(r, exactModelCounts) {
  const key = normalizeModelAlias(r?.modelId)
  return key && normalizeModelAlias(r?.providerKey).startsWith('openai-compatible:') && (exactModelCounts.get(key) || 0) > 1
}

function getModelGroupKey(r, canonicalizeFn, exactModelCounts) {
  if (hasDuplicateExactModelId(r, exactModelCounts)) return getRoutingModelKey(r)

  const labelKey = normalizeModelLabel(r?.label)
  if (labelKey) return labelKey

  if (typeof canonicalizeFn === 'function') {
    const { unprefixed, base } = canonicalizeFn(r?.modelId || '')
    return normalizeModelAlias(unprefixed || base)
  }

  return normalizeModelAlias(r?.modelId || '')
}

function collectModelAliases(r, canonicalizeFn) {
  const aliases = new Set()
  const push = value => {
    const normalized = normalizeModelAlias(value)
    if (normalized) aliases.add(normalized)
  }

  push(r?.modelId)
  push(resolveAliasedModelId(r?.modelId))
  push(r?.label)
  push(getPreferredModelLabel(r?.modelId))
  if (typeof canonicalizeFn === 'function') {
    const { base, unprefixed } = canonicalizeFn(r?.modelId || '')
    push(base)
    push(unprefixed)
  }
  return aliases
}

function getModelGroupId(r, canonicalizeFn, displayLabel, exactModelCounts) {
  if (hasDuplicateExactModelId(r, exactModelCounts)) return getRoutingModelKey(r)

  if (typeof canonicalizeFn === 'function') {
    const { unprefixed, base } = canonicalizeFn(r?.modelId || '')
    const canonicalId = normalizeModelAlias(unprefixed || base)
    if (canonicalId) return canonicalId
  }

  const labelBasedId = normalizeModelLabel(displayLabel).replace(/\s+/g, '-')
  return labelBasedId || normalizeModelAlias(r?.modelId || '')
}

export function buildModelGroups(results, canonicalizeFn) {
  const groups = new Map()
  const exactModelCounts = getExactModelCounts(results)

  for (const r of results) {
    const key = getModelGroupKey(r, canonicalizeFn, exactModelCounts)
    if (!key) continue

    if (!groups.has(key)) {
      const displayLabel = toDisplayModelLabel(r.label, r.modelId)
      const groupId = getModelGroupId(r, canonicalizeFn, displayLabel, exactModelCounts)
      groups.set(key, {
        id: groupId,
        label: displayLabel,
        aliases: new Set(),
        models: [],
      })
    }

    const group = groups.get(key)
    group.models.push(r)
    for (const alias of collectModelAliases(r, canonicalizeFn)) {
      group.aliases.add(alias)
    }
  }

  return Array.from(groups.values())
    .map(group => ({
      id: group.id,
      label: group.label,
      aliases: Array.from(group.aliases),
      models: group.models,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

const TAG_REQUEST_PREFIX = 'tag:'

/**
 * Parses a human-readable context-size string ("128k", "1m", "32000") into a raw token count.
 * Returns null for anything unparseable/empty. Used by the `tag:<name>+min_ctx:<n>` request
 * syntax to filter out models whose context window can't fit the caller's stated requirement.
 */
export function parseContextSize(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null

  const str = String(value).trim().toLowerCase()
  if (!str || str === '—') return null
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([km])?$/)
  if (!match) return null
  const num = Number(match[1])
  if (!Number.isFinite(num) || num <= 0) return null
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  return Math.round(num * multiplier)
}

/**
 * Parses `+`-delimited `key:value` modifiers, e.g. the `min_ctx:32000` in
 * `tag:general+min_ctx:32000` or `auto-fastest+min_ctx:128k`, or the `exclude:<id>` in
 * `tag:general+exclude:groq/qwen/qwen3.8-27b`. Unknown modifier keys are ignored rather than
 * rejected, so new modifiers can be added later without breaking older callers or requiring a
 * new reserved prefix per modifier.
 */
function parseModifiers(parts) {
  let minCtx = null
  let excludeIds = null
  for (const part of parts) {
    const sepIdx = part.indexOf(':')
    if (sepIdx === -1) continue
    const key = part.slice(0, sepIdx).trim()
    const value = part.slice(sepIdx + 1).trim()
    if (key === 'min_ctx' && value) {
      const parsed = parseContextSize(value)
      if (parsed != null) minCtx = parsed
    } else if (key === 'exclude' && value) {
      const ids = value.split('|').map(s => s.trim()).filter(Boolean)
      if (ids.length > 0) excludeIds = ids
    }
  }
  return { minCtx, excludeIds }
}

/**
 * Parses a `tag:<name>[+modifier...]` request. The tag name is always the first
 * `+`-delimited segment; anything after that is passed to parseModifiers().
 */
function parseTagRequest(rest) {
  const parts = String(rest || '').split('+').map(s => s.trim()).filter(Boolean)
  const tag = parts[0] || ''
  const { minCtx, excludeIds } = parseModifiers(parts.slice(1))
  return { tag, minCtx, excludeIds }
}

// The model string a caller asked for, as recorded in the request log. It is caller-controlled (the router
// API takes any `model`, and selector modifiers like `+exclude:<text>` accept arbitrary text), so bound its
// size; the dashboard escapes it when rendering.
export const MAX_REQUESTED_MODEL_LENGTH = 200
export function normalizeRequestedModel(value) {
  return typeof value === 'string' && value ? value.slice(0, MAX_REQUESTED_MODEL_LENGTH) : null
}

/**
 * The context window `min_ctx` matching actually uses for a model, and why. Shared by routing
 * (matchesMinCtx) and the dashboard so what the UI shows is exactly what routing decides on.
 *
 * `usable` is false when there is no trustworthy number: the context is only the model's
 * maximum (not what the provider allocates) or it is unknown. Otherwise `tokens` is the reported
 * window, capped by the observed per-minute token quota when that is smaller (`capped`).
 */
export function getEffectiveContext(result) {
  const reportedTokens = parseContextSize(result?.ctx)
  const rateLimitTokens = result?.rateLimit?.limitTokens
  const quotaTokens = (typeof rateLimitTokens === 'number' && rateLimitTokens > 0) ? rateLimitTokens : null
  if (result?.ctxSource === 'model-maximum') {
    return { tokens: null, reportedTokens, quotaTokens, capped: false, usable: false, reason: 'model-maximum' }
  }
  if (reportedTokens == null) {
    return { tokens: null, reportedTokens: null, quotaTokens, capped: false, usable: false, reason: 'unknown' }
  }
  const capped = quotaTokens != null && quotaTokens < reportedTokens
  return { tokens: capped ? quotaTokens : reportedTokens, reportedTokens, quotaTokens, capped, usable: true, reason: capped ? 'quota' : 'reported' }
}

function matchesMinCtx(result, minCtx) {
  if (minCtx == null) return true
  // A model's advertised/reported context window is only half the story -- some providers
  // (seen live on Groq's newly-discovered preview models, e.g. qwen/qwen3.8-27b reporting a
  // 131k window while this account's actual per-minute token quota for it is 8000) cap real
  // throughput far below what the catalog claims, the same class of bug fixed for Cerebras'
  // zai-glm-4.7 in #73 -- except here ModelRelay already captures the real number itself via
  // response rate-limit headers (result.rateLimit.limitTokens), so use it instead of requiring
  // a new hardcoded catalog override every time another provider does this.
  const effective = getEffectiveContext(result)
  return effective.usable && effective.tokens >= minCtx
}

/**
 * Backs the `+exclude:<id1|id2>` modifier -- lets a caller steer a `tag:<name>`/`auto-fastest`
 * request away from specific models (e.g. one that just failed on a prior call), without a
 * global/persistent ban. Reuses the same dual bare-modelId/provider-key matching as the
 * internal per-request attempted-model exclusion (isRoutingModelExcluded/getRoutingModelKey)
 * so `+exclude:` and the retry loop's own self-exclusion behave identically.
 */
function matchesExclude(result, excludedSet) {
  if (!excludedSet || excludedSet.size === 0) return true
  return !isRoutingModelExcluded(result, excludedSet)
}

export function filterModelsByRequested(results, requestedModel, canonicalizeFn) {
  if (!requestedModel) return results

  const requested = normalizeModelAlias(requestedModel)
  if (requested === 'auto-fastest') return results

  // auto-fastest+min_ctx:<n>[+exclude:<id1|id2>]: same QoS-driven "fastest" selection as
  // auto-fastest, but restricted to models that can actually fit a prompt of the caller's
  // stated size -- see https://github.com/ellipticmarketing/modelrelay/issues/42 -- and/or
  // that avoid specific model IDs the caller wants steered away from.
  if (requested.startsWith('auto-fastest+')) {
    const parts = requested.slice('auto-fastest+'.length).split('+').map(s => s.trim()).filter(Boolean)
    const { minCtx, excludeIds } = parseModifiers(parts)
    if (minCtx == null && excludeIds == null) return results
    const excludedSet = excludeIds ? normalizeExcludedModelKeys(excludeIds) : null
    return results.filter(result => matchesMinCtx(result, minCtx) && matchesExclude(result, excludedSet))
  }

  if (requested.startsWith(TAG_REQUEST_PREFIX)) {
    const { tag, minCtx, excludeIds } = parseTagRequest(requested.slice(TAG_REQUEST_PREFIX.length))
    if (!tag) return []
    const excludedSet = excludeIds ? normalizeExcludedModelKeys(excludeIds) : null
    return results.filter(result => {
      const tags = [...getBuiltInModelTags(result.modelId), ...(Array.isArray(result.tags) ? result.tags : [])]
      return tags.includes(tag) && matchesMinCtx(result, minCtx) && matchesExclude(result, excludedSet)
    })
  }
  const providerQualifiedMatches = results.filter(r => getRoutingModelKey(r) === requested)
  if (providerQualifiedMatches.length > 0) return providerQualifiedMatches

  const exactMatches = results.filter(r => normalizeModelAlias(r.modelId) === requested)
  if (exactMatches.length > 0) return exactMatches

  if (typeof canonicalizeFn === 'function') {
    const baseMatches = results.filter(r => {
      const { base } = canonicalizeFn(r.modelId)
      return normalizeModelAlias(base) === requested
    })
    if (baseMatches.length > 0) return baseMatches
  }

  const groups = buildModelGroups(results, canonicalizeFn)
  const matchedGroup = groups.find(group => group.aliases.includes(requested))
  return matchedGroup ? matchedGroup.models : []
}

export function isRetryableProxyStatus(status) {
  const code = Number(status)
  if (!Number.isInteger(code)) return false
  return code === 429 || code === 410 || code >= 500
}

// Narrow, provider-agnostic detection of "account/request is over some capacity limit" errors
// that a provider reports as a plain 4xx rather than 429 -- seen live: Groq returns 400
// "Please reduce your message size ... tokens per minute (TPM)" for a TPM-quota overage, which
// isRetryableProxyStatus() doesn't catch, so the proactive retry loop's own model-exclusion
// (attemptedModelKeys, see server.js) never got a chance to try a different candidate and the
// failure went straight to the caller. Deliberately narrow -- only fires for status codes that
// are otherwise ambiguous 4xx classes (400, 403), and only when the body contains one of a
// short list of rate-limit/quota-shaped phrases -- NOT a blanket "retry all 400s", which would
// risk retrying (and masking) a genuinely malformed request instead of failing it fast.
const RATE_LIMIT_BODY_PATTERNS = [
  /rate.?limit/i,
  /\btpm\b/i,
  /\brpm\b/i,
  /tokens per minute/i,
  /requests per minute/i,
  /quota/i,
  /reduce your message size/i,
]

export function isRateLimitShapedError(status, bodyText) {
  const code = Number(status)
  if (code !== 400 && code !== 403) return false
  if (typeof bodyText !== 'string' || !bodyText) return false
  return RATE_LIMIT_BODY_PATTERNS.some(re => re.test(bodyText))
}

// A provider rejecting the request *shape* with a 400/422 -- not because the caller sent something
// malformed, but because this particular provider/model can't handle part of it. Seen live: an
// agent's tool definitions included the JSON Schema keyword `uniqueItems`, and kilocode's
// qwen/qwen3.8-27b:free (served by ModelRun) answered 400 "grammar does not compile: xgrammar
// StructuralTag compilation failed ... unsupported schema keyword: uniqueItems". Other models
// accept the same request, so the right move is to try a different candidate rather than hand the
// 400 straight back. Deliberately narrow -- specific compiler/capability phrases only, not a
// blanket "retry all 400s", which would mask genuinely malformed requests.
const PROVIDER_REJECTION_BODY_PATTERNS = [
  /grammar does not compile/i,
  /unsupported schema keyword/i,
  /xgrammar/i,
  /structural ?tag/i,
  /failed to compile.{0,40}(schema|grammar)/i,
  /does not support (tools|tool use|function calling|structured output)/i,
  /(tools?|tool_choice|function calling|response_format).{0,40}(is |are )?not supported/i,
]

// Error codes that describe the MODEL, not the request: this model is unknown here, it does
// not offer the feature, or its context window is too small for what was sent. Another model
// in the pool can serve the same request, so the router should move on instead of handing the
// error back to the caller.
const MODEL_SCOPED_ERROR_CODES = new Set([
  'model_not_found',
  'model_not_supported',
  'model_unavailable',
  'model_deprecated',
  'model_disabled',
  'invalid_model',
  'not_found',
  'unknown_model',
  'context_length_exceeded',
  'max_tokens_exceeded',
  'max_context_length_exceeded',
  'content_too_long',
  'input_too_long',
  'prompt_too_long',
  'unsupported_parameter',
  'unsupported_value',
  'unsupported_feature',
  'unsupported_model',
  'feature_not_supported',
])

const MODEL_SCOPED_ERROR_PHRASES = [
  /model[^.]{0,40}\bnot found\b/i,
  /model[^.]{0,60}\bdoes ?n[o']t exist\b/i,
  /\bdoes ?n[o']t exist\b[^.]{0,40}\bmodel\b/i,
  /\bmodel\b[^.]{0,40}\bno longer (exists|available)\b/i,
  /\bno such model\b/i,
  /\bunknown model\b/i,
  /\bmodel is not (available|supported|enabled)\b/i,
  /\bdoes not support (this|the)\b/i,
  /\bnot supported by (this|the) model\b/i,
  /\bexceeds? (the )?(model'?s? )?maximum context length\b/i,
  /\bcontext length[^.]{0,40}\bexceed/i,
  /\bmaximum context length\b/i,
  /\btoo many tokens\b/i,
  /\breduce the length\b/i,
  /\bprompt is too long\b/i,
  /\bcontent too long\b/i,
  /\bunsupported (parameter|value|feature|model|content type)\b/i,
]

/**
 * Is this a model-scoped error -- one that a different model in the pool could still serve?
 *
 * A 404 is always model-scoped: the provider does not have that model. A 400 or 422 is
 * model-scoped when the body names a model problem (unknown model, context window too small,
 * feature not offered) -- either through an OpenAI-style error code or through the phrasing
 * providers use.
 *
 * Deliberately not covered: 401, an invalid key, an exhausted account quota, and a plain
 * malformed request. Those fail on every model, so retrying them would only delay the error
 * the caller needs to see.
 */
export function isModelScopedError(status, bodyText) {
  const code = Number(status)
  if (code === 404) return true
  if (code !== 400 && code !== 422) return false
  if (typeof bodyText !== 'string' || !bodyText) return false

  // OpenAI-style error envelopes: { "error": { "code": "...", "type": "..." } }
  let codes = []
  try {
    const parsed = JSON.parse(bodyText)
    const err = parsed?.error
    if (err && typeof err === 'object') {
      if (typeof err.code === 'string') codes.push(err.code)
      if (typeof err.type === 'string') codes.push(err.type)
    }
    if (typeof parsed?.code === 'string') codes.push(parsed.code)
  } catch { /* not JSON -- fall through to the phrase check */ }

  const normalizedCodes = codes.map(c => c.trim().toLowerCase().replace(/[\s-]+/g, '_'))
  if (normalizedCodes.some(c => MODEL_SCOPED_ERROR_CODES.has(c))) return true

  return MODEL_SCOPED_ERROR_PHRASES.some(re => re.test(bodyText))
}

export function isProviderRequestRejectionError(status, bodyText) {
  const code = Number(status)
  if (code !== 400 && code !== 422) return false
  if (typeof bodyText !== 'string' || !bodyText) return false
  return PROVIDER_REJECTION_BODY_PATTERNS.some(re => re.test(bodyText))
}

/**
 * Did an OpenAI-style SSE stream finish properly? True when it ends with `data: [DONE]` or any chunk
 * carries a non-null `finish_reason`. A stream that stops after some content with neither was cut off
 * -- the upstream dropped it or closed it early -- even though its HTTP status was 200.
 */
export function isCompleteSseStream(text) {
  if (typeof text !== 'string' || !text) return false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return true
    if (!payload) continue
    try {
      const chunk = JSON.parse(payload)
      if (Array.isArray(chunk?.choices) && chunk.choices.some(choice => choice && choice.finish_reason)) return true
    } catch { /* partial or non-JSON line */ }
  }
  return false
}

const SSE_STREAM_PEEK_MAX_BYTES = 8192

// Seen live: an upstream (AtlasCloud, via kilocode) returned a 200 and opened an SSE stream, then
// immediately ended it with a finish_reason-but-no-content first chunk and nothing else -- the
// request "succeeded" by HTTP status alone, so isRetryableProxyStatus()/isRateLimitShapedError()
// never see it, and the proactive retry loop's model-exclusion never gets a chance to try a
// different candidate. Only the *first* event is inspected -- once any real content has reached
// the caller, the response is already committed and can't be retried without corrupting it.
export function isErrorShapedFirstSseEvent(eventText) {
  if (typeof eventText !== 'string' || !eventText) return false
  const dataLine = eventText.split('\n').find(line => line.trim().startsWith('data:'))
  if (!dataLine) return false
  const payload = dataLine.trim().slice(5).trim()
  if (!payload) return false
  if (payload === '[DONE]') return true // stream ended before producing a single real chunk
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return false // fail open -- don't block traffic over an unparseable peek
  }
  if (parsed && typeof parsed === 'object' && parsed.error) return true
  const choice = parsed?.choices?.[0]
  if (!choice) return false
  const hasContent = Boolean(choice.delta?.content) || Boolean(choice.delta?.tool_calls?.length) || Boolean(choice.delta?.function_call)
  return Boolean(choice.finish_reason) && !hasContent
}

// Reads just enough of a streaming response body to judge isErrorShapedFirstSseEvent(), then
// returns a reconstructed stream that replays the peeked bytes followed by the rest of the
// original stream unchanged -- so a healthy stream can still be piped through with no data loss
// and (beyond the time the first chunk would have arrived anyway) no added latency.
export async function peekFirstSseEvent(body, { maxBytes = SSE_STREAM_PEEK_MAX_BYTES } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = new Uint8Array(0)
  let text = ''
  let streamDone = false

  while (!streamDone && !text.includes('\n\n') && buffered.length < maxBytes) {
    const { value, done } = await reader.read()
    streamDone = done
    if (value && value.length > 0) {
      const merged = new Uint8Array(buffered.length + value.length)
      merged.set(buffered)
      merged.set(value, buffered.length)
      buffered = merged
      text += decoder.decode(value, { stream: true })
    }
  }

  const rebuilt = new ReadableStream({
    start(controller) {
      if (buffered.length > 0) controller.enqueue(buffered)
      if (streamDone) controller.close()
    },
    async pull(controller) {
      const { value, done } = await reader.read()
      if (value && value.length > 0) controller.enqueue(value)
      if (done) controller.close()
    },
  })

  return { body: rebuilt, errorShaped: isErrorShapedFirstSseEvent(text), raw: text }
}

/**
 * Computes the "last refreshed at" timestamp to record after a *failed* discovery/model-sync
 * attempt, so the next TTL check allows a retry after `retryBackoffMs` instead of waiting out
 * the full `refreshIntervalMs` success TTL. Without this, one transient network failure gets
 * treated the same as a successful refresh and silently locks out automatic retries for the
 * whole TTL window (up to an hour, depending on the provider) until a manual force-refresh.
 */
export function computeFailedRefreshRetryAt(now, refreshIntervalMs, retryBackoffMs) {
  return now - refreshIntervalMs + retryBackoffMs
}

export function parseArgs(argv) {
  const args = argv.slice(2)
  const firstCommandToken = args.find(a => !a.startsWith('--'))
  const command = firstCommandToken ? firstCommandToken.toLowerCase() : 'run'
  const hasOnboardToken = args.some(a => a.toLowerCase() === 'onboard' || a.toLowerCase() === '--onboard')
  const hasAutostartToken = args.some(a => a.toLowerCase() === 'autostart' || a.toLowerCase() === '--autostart')
  const showHelp = args.some(a => ['--help', '-h', 'help'].includes(a.toLowerCase()))

  const hasLogFlag = args.some(a => a.toLowerCase() === '--log')
  const hasNoLogFlag = args.some(a => a.toLowerCase() === '--no-log')
  const enableLog = hasLogFlag && !hasNoLogFlag

  const hasInstallFlag = args.some(a => a.toLowerCase() === '--install')
  const hasStartFlag = args.some(a => a.toLowerCase() === '--start')
  const hasUninstallFlag = args.some(a => a.toLowerCase() === '--uninstall')
  const hasStatusFlag = args.some(a => a.toLowerCase() === '--status')
  const hasEnableFlag = args.some(a => a.toLowerCase() === '--enable')
  const hasDisableFlag = args.some(a => a.toLowerCase() === '--disable')

  let autostartAction = null
  let autoUpdateAction = null
  if (command === 'install' && hasAutostartToken) autostartAction = 'install'
  if (command === 'start' && hasAutostartToken) autostartAction = 'start'
  if (command === 'uninstall' && hasAutostartToken) autostartAction = 'uninstall'
  if (command === 'status' && hasAutostartToken) autostartAction = 'status'

  if (command === 'autostart') {
    const positionalAction = args.find((a, idx) => idx > 0 && ['install', 'start', 'uninstall', 'status'].includes(a.toLowerCase()))
    if (hasInstallFlag || positionalAction?.toLowerCase() === 'install') autostartAction = 'install'
    else if (hasStartFlag || positionalAction?.toLowerCase() === 'start') autostartAction = 'start'
    else if (hasUninstallFlag || positionalAction?.toLowerCase() === 'uninstall') autostartAction = 'uninstall'
    else if (hasStatusFlag || positionalAction?.toLowerCase() === 'status') autostartAction = 'status'
    else autostartAction = 'status'
  }

  if (command === 'autoupdate') {
    if (hasEnableFlag) autoUpdateAction = 'enable'
    else if (hasDisableFlag) autoUpdateAction = 'disable'
    else if (hasStatusFlag) autoUpdateAction = 'status'
    else autoUpdateAction = 'status'
  }

  if (hasEnableFlag && command !== 'autoupdate') autoUpdateAction = 'enable'
  if (hasDisableFlag && command !== 'autoupdate') autoUpdateAction = 'disable'

  const portIdx = args.findIndex(a => a.toLowerCase() === '--port')
  const portValueIdx = (portIdx !== -1 && args[portIdx + 1] && !args[portIdx + 1].startsWith('--'))
    ? portIdx + 1
    : -1

  const banIdx = args.findIndex(a => a.toLowerCase() === '--ban')
  const banValueIdx = (banIdx !== -1 && args[banIdx + 1] && !args[banIdx + 1].startsWith('--'))
    ? banIdx + 1
    : -1

  const intervalIdx = args.findIndex(a => a.toLowerCase() === '--interval')
  const intervalValueIdx = (intervalIdx !== -1 && args[intervalIdx + 1] && !args[intervalIdx + 1].startsWith('--'))
    ? intervalIdx + 1
    : -1

  let bannedModels = []
  if (banValueIdx !== -1) {
    bannedModels = args[banValueIdx].split(',').map(s => s.trim()).filter(Boolean)
  }

  let portValue = 7352
  if (portValueIdx !== -1) {
    portValue = parseInt(args[portValueIdx], 10) || 7352
  }

  // --host <address>: the interface to bind to (default: all interfaces). Use 127.0.0.1 to keep the router local.
  const hostIdx = args.findIndex(a => a.toLowerCase() === '--host')
  const hostValue = (hostIdx !== -1 && args[hostIdx + 1] && !args[hostIdx + 1].startsWith('--')) ? args[hostIdx + 1].trim() : null

  let autoUpdateIntervalHours = null
  if (intervalValueIdx !== -1) {
    const parsed = Number(args[intervalValueIdx])
    if (Number.isFinite(parsed) && parsed > 0) {
      autoUpdateIntervalHours = parsed
    }
  }

  let configAction = null
  let configPayload = null
  let configProvider = null
  let configKeys = null
  let configMaxTurns = null
  if (command === 'config') {
    const actionIdx = args.findIndex((a, idx) => idx > 0 && !a.startsWith('--'))
    const action = actionIdx !== -1 ? args[actionIdx].toLowerCase() : null
    if (action === 'export' || action === 'import') {
      configAction = action
    }
    if (configAction === 'import' && actionIdx !== -1) {
      const payload = args.slice(actionIdx + 1).join(' ').trim()
      if (payload) configPayload = payload
    }
    if (action === 'set-keys' || action === 'add-key' || action === 'remove-key') {
      configAction = action
      if (args.length > 2) {
        configProvider = args[2]
      }
      if (args.length > 3) {
        configKeys = args.slice(3).join(' ')
      }
    }
    if (action === 'set-maxturns') {
      configAction = action
      if (args.length > 2) {
        configProvider = args[2]
      }
      if (args.length > 3) {
        configMaxTurns = args[3]
      }
    }
  }

  return {
    command,
    autostartAction,
    autoUpdateAction,
    portValue,
    hostValue,
    enableLog,
    bannedModels,
    autoUpdateIntervalHours,
    configAction,
    configPayload,
    configProvider,
    configKeys,
    configMaxTurns,
    autostart: hasAutostartToken,
    onboard: hasOnboardToken,
    help: showHelp,
  }
}

function parseNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseDateToMs(value) {
  if (!value) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000)
  }
  if (typeof value !== 'string') return null

  const asNum = parseNumber(value)
  if (asNum != null) {
    return asNum > 1e12 ? Math.round(asNum) : Math.round(asNum * 1000)
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseResetToAbsoluteMs(value) {
  if (value == null || value === '') return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return Math.round(value)
    if (value >= 1e10) return Math.round(value * 1000)
    return Date.now() + Math.round(value * 1000)
  }

  if (typeof value === 'string') {
    const numeric = parseNumber(value)
    if (numeric != null) return parseResetToAbsoluteMs(numeric)
  }

  return parseDateToMs(value)
}

export function parseOpenRouterKeyRateLimit(payload) {
  const data = payload && typeof payload === 'object'
    ? (payload.data && typeof payload.data === 'object' ? payload.data : payload)
    : null
  if (!data) return null

  const rateLimit = {}

  const creditLimit = parseNumber(data.limit)
  if (creditLimit != null) rateLimit.creditLimit = creditLimit

  const creditRemaining = parseNumber(data.limit_remaining)
  if (creditRemaining != null) rateLimit.creditRemaining = creditRemaining

  const creditResetAt = parseDateToMs(data.limit_reset)
  if (creditResetAt != null) rateLimit.creditResetAt = creditResetAt

  const legacy = data.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : null
  if (legacy) {
    const reqLimit = parseNumber(legacy.limit_requests ?? legacy.requests_limit ?? legacy.request_limit ?? legacy.limit)
    if (reqLimit != null) rateLimit.limitRequests = reqLimit

    const reqRemaining = parseNumber(legacy.remaining_requests ?? legacy.requests_remaining ?? legacy.request_remaining ?? legacy.remaining)
    if (reqRemaining != null) rateLimit.remainingRequests = reqRemaining

    const reqResetAt = parseResetToAbsoluteMs(legacy.reset_requests ?? legacy.requests_reset ?? legacy.reset)
    if (reqResetAt != null) rateLimit.resetRequestsAt = reqResetAt

    const tokLimit = parseNumber(legacy.limit_tokens ?? legacy.tokens_limit)
    if (tokLimit != null) rateLimit.limitTokens = tokLimit

    const tokRemaining = parseNumber(legacy.remaining_tokens ?? legacy.tokens_remaining)
    if (tokRemaining != null) rateLimit.remainingTokens = tokRemaining

    const tokResetAt = parseResetToAbsoluteMs(legacy.reset_tokens ?? legacy.tokens_reset)
    if (tokResetAt != null) rateLimit.resetTokensAt = tokResetAt
  }

  return Object.keys(rateLimit).length > 0 ? rateLimit : null
}
