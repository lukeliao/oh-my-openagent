import { afterEach, describe, expect, test } from "bun:test"

import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_WINDOW_MS,
  decidePacedRetry,
  extractRetryAfterMs,
  isPacedRetryProvider,
  OPENAI_TAOBAO_PROVIDER_ID,
  shouldFastFailPacedRetry,
} from "./provider-retry-governor"

const originalDateNow = Date.now

afterEach(() => {
  Date.now = originalDateNow
})

describe("provider-retry-governor", () => {
  test("recognizes openai_taobao as paced retry provider", () => {
    expect(isPacedRetryProvider(OPENAI_TAOBAO_PROVIDER_ID)).toBe(true)
    expect(isPacedRetryProvider("openai")).toBe(false)
  })

  test("accumulates attempt count until retry budget is exhausted", () => {
    const baseTime = 1_000

    const fifthAttempt = decidePacedRetry(
      { attemptCount: DEFAULT_RETRY_MAX_ATTEMPTS - 1, startedAt: baseTime },
      { providerID: OPENAI_TAOBAO_PROVIDER_ID, nowMs: baseTime + 1_000, random: () => 0 },
    )

    expect(fifthAttempt.exhausted).toBe(false)
    expect(fifthAttempt.shouldPace).toBe(true)
    expect(fifthAttempt.nextAttemptCount).toBe(DEFAULT_RETRY_MAX_ATTEMPTS)

    const exhaustedAttempt = decidePacedRetry(
      { attemptCount: DEFAULT_RETRY_MAX_ATTEMPTS, startedAt: baseTime },
      { providerID: OPENAI_TAOBAO_PROVIDER_ID, nowMs: baseTime + 2_000, random: () => 0 },
    )

    expect(exhaustedAttempt.exhausted).toBe(true)
    expect(exhaustedAttempt.shouldPace).toBe(false)
    expect(exhaustedAttempt.delayMs).toBe(0)
    expect(exhaustedAttempt.nextAttemptCount).toBe(DEFAULT_RETRY_MAX_ATTEMPTS + 1)
  })

  test("exhausts paced retry once the retry window elapses", () => {
    const baseTime = 5_000

    const decision = decidePacedRetry(
      { attemptCount: 1, startedAt: baseTime },
      {
        providerID: OPENAI_TAOBAO_PROVIDER_ID,
        nowMs: baseTime + DEFAULT_RETRY_WINDOW_MS,
        random: () => 0,
      },
    )

    expect(decision.retryElapsedMs).toBe(DEFAULT_RETRY_WINDOW_MS)
    expect(decision.exhausted).toBe(true)
    expect(decision.shouldPace).toBe(false)
  })

  test("honors numeric Retry-After values in seconds", () => {
    const retryAfterMs = extractRetryAfterMs({ data: { retryAfter: 3 } })

    expect(retryAfterMs).toBe(3_000)
  })

  test("honors HTTP-date Retry-After headers", () => {
    Date.now = () => 1_000

    const retryAfterMs = extractRetryAfterMs({
      headers: { "retry-after": new Date(6_000).toUTCString() },
    })

    expect(retryAfterMs).toBe(5_000)
  })

  test("uses Retry-After delay instead of exponential backoff when present", () => {
    const decision = decidePacedRetry(
      { attemptCount: 1, startedAt: 10_000 },
      {
        providerID: OPENAI_TAOBAO_PROVIDER_ID,
        nowMs: 11_000,
        retryAfterMs: 7_000,
        random: () => 0,
      },
    )

    expect(decision.shouldPace).toBe(true)
    expect(decision.delayMs).toBe(7_000)
    expect(decision.nextAttemptCount).toBe(2)
    expect(decision.retryElapsedMs).toBe(1_000)
  })

  test("fast-fails authentication and user/config errors for paced retry provider", () => {
    expect(shouldFastFailPacedRetry({
      statusCode: 401,
      name: "AuthenticationError",
      message: "Unauthorized: invalid API key",
    })).toBe(true)

    expect(shouldFastFailPacedRetry({
      statusCode: 400,
      message: "Bad request: unsupported model",
    })).toBe(true)

    expect(shouldFastFailPacedRetry({
      statusCode: 503,
      message: "Service unavailable",
    })).toBe(false)
  })
})
