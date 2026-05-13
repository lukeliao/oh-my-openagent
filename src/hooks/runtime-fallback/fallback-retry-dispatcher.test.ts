import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { createFallbackState } from "./fallback-state"
import { createBoulderState, readWorkStopDetail, writeBoulderState } from "../../features/boulder-state/storage"

function createDeps(): HookDeps {
  return {
    ctx: {
      directory: "/test/dir",
      client: {
        session: {
          abort: async () => ({}),
          messages: async () => ({ data: [] }),
          promptAsync: async () => ({}),
        },
        tui: {
          showToast: async () => ({}),
        },
      },
    },
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {},
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

const tempDirectories: string[] = []

function createTestDirectory(prefix: string): string {
  const directory = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createHelpers() {
  const autoRetryWithFallback = mock(async () => {})
  const helpers: AutoRetryHelpers = {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: () => {},
    scheduleSessionFallbackTimeout: () => {},
    autoRetryWithFallback,
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }

  return { helpers, autoRetryWithFallback }
}

describe("dispatchFallbackRetry", () => {
  test("records exhaustion metadata and stops scheduling when openai_taobao retry budget is exhausted", async () => {
    const deps = createDeps()
    const { helpers, autoRetryWithFallback } = createHelpers()
    const state = createFallbackState("openai_taobao/gpt-5.5")
    state.currentModel = "openai_taobao/gpt-5.5"
    state.attemptCount = 5
    state.retryStartedAtMs = 1_000

    const originalDateNow = Date.now
    Date.now = () => 3_500

    try {
      await dispatchFallbackRetry(deps, helpers, {
        sessionID: "session-exhausted",
        state,
        fallbackModels: ["openai_taobao/gpt-5.5"],
        resolvedAgent: "sisyphus",
        source: "session.error",
        error: { statusCode: 503, message: "Service unavailable" },
      })
    } finally {
      Date.now = originalDateNow
    }

    expect(autoRetryWithFallback).not.toHaveBeenCalled()
    expect(state.providerExhausted).toBe(true)
    expect(state.exhaustedProvider).toBe("openai_taobao")
    expect(state.providerExhaustedAt).toBeString()
    expect(state.attemptCount).toBe(6)
    expect(state.retryElapsedMs).toBe(2_500)
    expect(state.lastError).toBe("provider_unavailable")
  })

  test("fast-fails authentication errors for openai_taobao without scheduling delayed retry", async () => {
    const deps = createDeps()
    const { helpers, autoRetryWithFallback } = createHelpers()
    const state = createFallbackState("openai_taobao/gpt-5.5")
    state.currentModel = "openai_taobao/gpt-5.5"

    await dispatchFallbackRetry(deps, helpers, {
      sessionID: "session-auth-fail",
      state,
      fallbackModels: ["openai_taobao/gpt-5.5"],
      resolvedAgent: "sisyphus",
      source: "session.error",
      error: {
        statusCode: 401,
        name: "AuthenticationError",
        message: "Unauthorized: invalid API key",
      },
    })

    expect(autoRetryWithFallback).not.toHaveBeenCalled()
    expect(state.providerExhausted).toBe(true)
    expect(state.exhaustedProvider).toBe("openai_taobao")
    expect(state.providerExhaustedAt).toBeString()
    expect(state.lastError).toBe("authentication")
    expect(state.attemptCount).toBe(1)
  })

  test("emits exactly one provider exhaustion summary with structured retry facts and persists stop detail", async () => {
    const directory = createTestDirectory("runtime-fallback-summary")
    const planPath = join(directory, ".sisyphus", "plans", "task-6.md")
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, "# Task 6\n- [ ] summary")
    writeBoulderState(directory, createBoulderState(planPath, "session-exhausted", "sisyphus"))

    const showToast = mock(async () => ({}))
    const deps = createDeps()
    deps.ctx.directory = directory
    deps.ctx.client.tui.showToast = showToast

    const { helpers, autoRetryWithFallback } = createHelpers()
    const state = createFallbackState("openai_taobao/gpt-5.5")
    state.currentModel = "openai_taobao/gpt-5.5"
    state.attemptCount = 5
    state.retryStartedAtMs = 1_000

    const originalDateNow = Date.now
    Date.now = () => 3_500

    try {
      await dispatchFallbackRetry(deps, helpers, {
        sessionID: "session-exhausted",
        state,
        fallbackModels: ["openai_taobao/gpt-5.5"],
        resolvedAgent: "sisyphus",
        source: "session.error",
        error: { statusCode: 503, message: "Service unavailable" },
      })

      await dispatchFallbackRetry(deps, helpers, {
        sessionID: "session-exhausted",
        state,
        fallbackModels: ["openai_taobao/gpt-5.5"],
        resolvedAgent: "sisyphus",
        source: "message.updated",
        error: { statusCode: 503, message: "Service unavailable" },
      })
    } finally {
      Date.now = originalDateNow
    }

    expect(autoRetryWithFallback).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({
      body: {
        title: "Provider Exhausted",
        variant: "error",
      },
    })
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("openai_taobao")
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("attempts: 6")
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("elapsed: 2500ms")
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("last error: provider_unavailable")
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("terminal reason: provider_exhausted")

    expect(readWorkStopDetail(directory)).toMatchObject({
      reason: "provider_exhausted",
      exhausted_provider: "openai_taobao",
      retry_attempts: 6,
      retry_elapsed_ms: 2_500,
      last_error: "provider_unavailable",
    })
  })
})
