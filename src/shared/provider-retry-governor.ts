export const OPENAI_TAOBAO_PROVIDER_ID = "openai_taobao"
export const DEFAULT_RETRY_WINDOW_MS = 30_000
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
export const DEFAULT_RETRY_MAX_DELAY_MS = 8_000
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5
export const DEFAULT_RETRY_JITTER_RATIO = 0.2

export interface RetryBudgetState {
  startedAt?: number
  attemptCount?: number
  exhaustedAt?: string
  exhaustedProvider?: string
  retryElapsedMs?: number
  lastError?: string
  providerExhausted?: boolean
}

export interface RetryableErrorLike {
  message?: string
  statusCode?: number
  status?: number
  name?: string
  data?: unknown
  error?: unknown
  cause?: unknown
  response?: unknown
  headers?: unknown
}

export interface RetryDelayOptions {
  attemptNumber: number
  retryAfterMs?: number
  nowMs?: number
  random?: () => number
}

export interface RetryGovernorOptions {
  providerID?: string
  nowMs?: number
  random?: () => number
  retryAfterMs?: number
}

export interface RetryDecision {
  shouldPace: boolean
  delayMs: number
  nextAttemptCount: number
  retryElapsedMs: number
  exhausted: boolean
}

export function shouldFastFailPacedRetry(error: RetryableErrorLike | undefined): boolean {
  if (!error) return false

  const failureReason = classifyRetryFailureReason(error)
  if (failureReason === "authentication") {
    return true
  }

  const statusCode = extractRetryStatusCode(error)
  if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return true
  }

  const message = extractRetryErrorMessage(error)?.toLowerCase() ?? ""
  return /bad request|invalid request|unsupported|not supported|unknown provider|model not found|invalid model|malformed/.test(message)
}

export function extractProviderIdFromModelString(model: string | undefined): string | undefined {
  if (!model) return undefined
  const slashIndex = model.indexOf("/")
  return slashIndex <= 0 ? undefined : model.slice(0, slashIndex)
}

function getNestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function getFirstNumber(values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value))
}

function getFirstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

export function isPacedRetryProvider(providerID: string | undefined): boolean {
  return providerID?.toLowerCase() === OPENAI_TAOBAO_PROVIDER_ID
}

export function classifyRetryFailureReason(error: RetryableErrorLike | undefined): string | undefined {
  if (!error) return undefined
  const name = error.name?.toLowerCase()
  if (name?.includes("auth") || name?.includes("apikey") || name?.includes("credential")) {
    return "authentication"
  }

  const message = extractRetryErrorMessage(error)?.toLowerCase() ?? ""
  if (/api.?key/.test(message) || /credential/.test(message) || /authentication/.test(message) || /unauthorized/.test(message)) {
    return "authentication"
  }
  if (/timeout|timed out|econnreset|socket hang up|network error|connection error/.test(message)) {
    return "transport"
  }

  const statusCode = extractRetryStatusCode(error)
  if (statusCode === 429) return "rate_limit"
  if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 529) {
    return "provider_unavailable"
  }

  return undefined
}

export function extractRetryStatusCode(error: RetryableErrorLike | undefined): number | undefined {
  if (!error) return undefined
  return getFirstNumber([
    error.statusCode,
    error.status,
    getNestedRecord(error.data)?.statusCode,
    getNestedRecord(error.data)?.status,
    getNestedRecord(error.error)?.statusCode,
    getNestedRecord(error.error)?.status,
    getNestedRecord(error.cause)?.statusCode,
    getNestedRecord(error.cause)?.status,
    getNestedRecord(error.response)?.status,
  ])
}

export function extractRetryErrorMessage(error: RetryableErrorLike | undefined): string | undefined {
  if (!error) return undefined
  return getFirstString([
    error.message,
    getNestedRecord(error.data)?.message,
    getNestedRecord(getNestedRecord(error.data)?.error)?.message,
    getNestedRecord(error.error)?.message,
    getNestedRecord(error.cause)?.message,
  ])
}

export function extractRetryAfterMs(error: RetryableErrorLike | undefined): number | undefined {
  if (!error) return undefined
  const candidates: unknown[] = [
    getNestedRecord(error.data)?.retryAfter,
    getNestedRecord(error.data)?.retry_after,
    getNestedRecord(error.error)?.retryAfter,
    getNestedRecord(error.error)?.retry_after,
    getNestedRecord(error.response)?.retryAfter,
    getNestedRecord(error.response)?.retry_after,
    getNestedRecord(getNestedRecord(error.response)?.headers)?.["retry-after"],
    getNestedRecord(error.headers)?.["retry-after"],
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate >= 1000 ? candidate : candidate * 1000
    }
    if (typeof candidate === "string") {
      const trimmed = candidate.trim()
      if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        return Math.round(Number(trimmed) * 1000)
      }
      const dateMs = Date.parse(trimmed)
      if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now())
      }
    }
  }

  return undefined
}

export function computeRetryDelayMs(options: RetryDelayOptions): number {
  const retryAfterMs = options.retryAfterMs
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs
  }

  const exponent = Math.max(0, options.attemptNumber - 1)
  const unclamped = DEFAULT_RETRY_BASE_DELAY_MS * (2 ** exponent)
  const capped = Math.min(DEFAULT_RETRY_MAX_DELAY_MS, unclamped)
  const random = options.random ?? Math.random
  const jitterWindow = Math.floor(capped * DEFAULT_RETRY_JITTER_RATIO)
  if (jitterWindow <= 0) {
    return capped
  }
  const jitter = Math.floor(random() * (jitterWindow + 1))
  return capped + jitter
}

export function decidePacedRetry(
  state: RetryBudgetState | undefined,
  options: RetryGovernorOptions = {},
): RetryDecision {
  const nowMs = options.nowMs ?? Date.now()
  const attemptCount = state?.attemptCount ?? 0
  const nextAttemptCount = attemptCount + 1
  const startedAt = state?.startedAt ?? nowMs
  const retryElapsedMs = Math.max(0, nowMs - startedAt)
  const exhausted = nextAttemptCount > DEFAULT_RETRY_MAX_ATTEMPTS || retryElapsedMs >= DEFAULT_RETRY_WINDOW_MS
  const shouldPace = isPacedRetryProvider(options.providerID) && !exhausted

  return {
    shouldPace,
    delayMs: shouldPace ? computeRetryDelayMs({
      attemptNumber: nextAttemptCount,
      retryAfterMs: options.retryAfterMs,
      nowMs,
      random: options.random,
    }) : 0,
    nextAttemptCount,
    retryElapsedMs,
    exhausted,
  }
}
