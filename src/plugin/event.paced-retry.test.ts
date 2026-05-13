import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"

import type { OhMyOpenCodeConfig } from "../config"
import type { CreatedHooks } from "../create-hooks"
import type { Managers } from "../create-managers"
import type { PluginContext } from "./types"
import { _resetForTesting, setMainSession, setSessionAgent } from "../features/claude-code-session-state"
import { createBoulderState, readWorkStopDetail, writeBoulderState } from "../features/boulder-state/storage"
import { OPENAI_TAOBAO_PROVIDER_ID } from "../shared/provider-retry-governor"

let decidePacedRetryDelegate: (state: { attemptCount?: number; startedAt?: number } | undefined) => {
  shouldPace: boolean
  delayMs: number
  nextAttemptCount: number
  retryElapsedMs: number
  exhausted: boolean
}

let classifyRetryFailureReasonDelegate: () => string | undefined = () => undefined

mock.module("../shared/provider-retry-governor", () => {
  return {
    OPENAI_TAOBAO_PROVIDER_ID,
    classifyRetryFailureReason: () => classifyRetryFailureReasonDelegate(),
    decidePacedRetry: (state: { attemptCount?: number; startedAt?: number } | undefined) =>
      decidePacedRetryDelegate(state),
    extractRetryAfterMs: () => undefined,
    isPacedRetryProvider: (providerID: string | undefined) => providerID === OPENAI_TAOBAO_PROVIDER_ID,
  }
})

mock.module("../hooks/model-fallback/hook", () => ({
  clearPendingModelFallback: () => {},
  clearSessionFallbackChain: () => {},
  setPendingModelFallback: () => true,
  setSessionFallbackChain: () => {},
}))

const eventModule = await import(`./event?test=shared-paced-retry-mocks`)

type FirstMessageVariantGate = {
  markSessionCreated: (sessionInfo: { id?: string; title?: string; parentID?: string } | undefined) => void
  clear: (sessionID: string) => void
}

function createPluginContext(): PluginContext {
  return {
    directory: "/tmp",
    client: {
      tui: {
        showToast: async () => ({}),
      },
      session: {
        abort: async () => ({}),
        promptAsync: async () => ({}),
        prompt: async () => ({}),
      },
    },
  } as unknown as PluginContext
}

function createPluginConfig(): OhMyOpenCodeConfig {
  return {
    agents: {
      sisyphus: {
        fallback_models: [`${OPENAI_TAOBAO_PROVIDER_ID}/gpt-5.5`],
      },
    },
  } as OhMyOpenCodeConfig
}

function createFirstMessageVariantGate(): FirstMessageVariantGate {
  return {
    markSessionCreated: () => {},
    clear: () => {},
  }
}

function createManagers(): Managers {
  return {
    tmuxSessionManager: {
      onSessionCreated: async () => {},
      onSessionDeleted: async () => {},
      onEvent: () => {},
    },
    skillMcpManager: {
      disconnectSession: async () => {},
    },
  } as unknown as Managers
}

function createHooks(): CreatedHooks {
  return {
    modelFallback: {},
    stopContinuationGuard: { isStopped: () => false },
  } as unknown as CreatedHooks
}

const tempDirectories: string[] = []

function createTempDirectory(prefix: string): string {
  const directory = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  mock.restore()
  _resetForTesting()
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("createEventHandler - paced retry", () => {
  test("preserves paced retry budget state across session.idle before the next openai_taobao retry", async () => {
    const decisionStates: Array<{ attemptCount?: number; startedAt?: number } | undefined> = []
    const decidePacedRetryMock = mock((state) => {
      decisionStates.push(state)
      return {
        shouldPace: true,
        delayMs: 1000,
        nextAttemptCount: (state?.attemptCount ?? 0) + 1,
        retryElapsedMs: 0,
        exhausted: false,
      }
    })
    decidePacedRetryDelegate = decidePacedRetryMock
    classifyRetryFailureReasonDelegate = () => undefined

    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const timerHandles: Array<{ cancelled: boolean }> = []

    globalThis.setTimeout = ((_: () => void | Promise<void>) => {
      const handle = { cancelled: false }
      timerHandles.push(handle)
      return handle as ReturnType<typeof setTimeout>
    }) as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      const typedHandle = handle as unknown as { cancelled?: boolean }
      typedHandle.cancelled = true
    }) as typeof globalThis.clearTimeout

    try {
      const sessionID = "ses_openai_taobao_idle_budget"
      setMainSession(sessionID)
      setSessionAgent(sessionID, "sisyphus")

      const eventHandler = eventModule.createEventHandler({
        ctx: createPluginContext(),
        pluginConfig: createPluginConfig(),
        firstMessageVariantGate: createFirstMessageVariantGate(),
        managers: createManagers(),
        hooks: createHooks(),
      })

      await eventHandler({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            providerID: OPENAI_TAOBAO_PROVIDER_ID,
            modelID: "gpt-5.5",
            error: { statusCode: 503, message: "Service unavailable" },
          },
        },
      })

      await eventHandler({
        event: {
          type: "session.idle",
          properties: { sessionID },
        },
      })

      await eventHandler({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            providerID: OPENAI_TAOBAO_PROVIDER_ID,
            modelID: "gpt-5.5",
            error: { statusCode: 503, message: "Service unavailable" },
          },
        },
      })

      expect(decisionStates).toHaveLength(2)
      expect(decisionStates[0]).toBeUndefined()
      expect(decisionStates[1]?.attemptCount).toBe(1)
      expect(timerHandles.length).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  test("emits exactly one terminal summary and persists stop detail when model-fallback paced retry budget is exhausted", async () => {
    const showToast = mock(async () => ({}))
    const decisionStates: Array<{ attemptCount?: number; startedAt?: number } | undefined> = []
    const decidePacedRetryMock = mock((state) => {
      decisionStates.push(state)
      return {
        shouldPace: true,
        delayMs: 1000,
        nextAttemptCount: (state?.attemptCount ?? 0) + 1,
        retryElapsedMs: 30_000,
        exhausted: true,
      }
    })
    decidePacedRetryDelegate = decidePacedRetryMock
    classifyRetryFailureReasonDelegate = () => "provider_unavailable"
    const directory = createTempDirectory("event-paced-exhausted")
    const planPath = join(directory, ".sisyphus", "plans", "task-6-paced.md")
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, "# Task 6 paced\n- [ ] summary")
    writeBoulderState(directory, createBoulderState(planPath, "ses_openai_taobao_exhausted", "sisyphus"))

    const sessionID = "ses_openai_taobao_exhausted"
    setMainSession(sessionID)
    setSessionAgent(sessionID, "sisyphus")

    const eventHandler = eventModule.createEventHandler({
      ctx: {
        ...createPluginContext(),
        directory,
        client: {
          ...createPluginContext().client,
          tui: { showToast },
        },
      },
      pluginConfig: createPluginConfig(),
      firstMessageVariantGate: createFirstMessageVariantGate(),
      managers: createManagers(),
      hooks: createHooks(),
    })

    const repeatedError = {
      event: {
        type: "session.error",
        properties: {
          sessionID,
          providerID: OPENAI_TAOBAO_PROVIDER_ID,
          modelID: "gpt-5.5",
          error: { statusCode: 503, message: "Service unavailable" },
        },
      },
    }

    await eventHandler(repeatedError)
    await eventHandler(repeatedError)

    expect(decisionStates).toHaveLength(2)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({
      body: {
        title: "Provider Exhausted",
        variant: "error",
      },
    })
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("openai_taobao")
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("attempts: 1")
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("elapsed: 30000ms")
    expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("last error: provider_unavailable")
    expect(readWorkStopDetail(directory)).toMatchObject({
      reason: "provider_exhausted",
      exhausted_provider: "openai_taobao",
      retry_attempts: 1,
      retry_elapsed_ms: 30_000,
      last_error: "provider_unavailable",
    })
  })

  test("emits terminal summary when delayed paced continue promptAsync fails", async () => {
    const showToast = mock(async () => ({}))
    const promptAsync = mock(async () => {
      throw new Error("promptAsync failed")
    })
    const decisionStates: Array<{ attemptCount?: number; startedAt?: number } | undefined> = []
    const decidePacedRetryMock = mock((state) => {
      decisionStates.push(state)
      return {
        shouldPace: true,
        delayMs: 1000,
        nextAttemptCount: (state?.attemptCount ?? 0) + 1,
        retryElapsedMs: 30_000,
        exhausted: false,
      }
    })
    decidePacedRetryDelegate = decidePacedRetryMock
    classifyRetryFailureReasonDelegate = () => "provider_unavailable"

    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    let scheduledCallback: (() => void | Promise<void>) | undefined

    globalThis.setTimeout = (((callback: () => void | Promise<void>) => {
      scheduledCallback = callback
      return { cancelled: false } as ReturnType<typeof setTimeout>
    }) as unknown) as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((_: ReturnType<typeof setTimeout>) => {}) as typeof globalThis.clearTimeout

    try {
      const directory = createTempDirectory("event-paced-prompt-failure")
      const planPath = join(directory, ".sisyphus", "plans", "task-6-paced.md")
      mkdirSync(dirname(planPath), { recursive: true })
      writeFileSync(planPath, "# Task 6 paced\n- [ ] summary")
      writeBoulderState(directory, createBoulderState(planPath, "ses_openai_taobao_prompt_failure", "sisyphus"))

      const sessionID = "ses_openai_taobao_prompt_failure"
      setMainSession(sessionID)
      setSessionAgent(sessionID, "sisyphus")

      const eventHandler = eventModule.createEventHandler({
        ctx: {
          ...createPluginContext(),
          directory,
          client: {
            ...createPluginContext().client,
            tui: { showToast },
            session: {
              ...createPluginContext().client.session,
              promptAsync,
            },
          },
        },
        pluginConfig: createPluginConfig(),
        firstMessageVariantGate: createFirstMessageVariantGate(),
        managers: createManagers(),
        hooks: createHooks(),
      })

      await eventHandler({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            providerID: OPENAI_TAOBAO_PROVIDER_ID,
            modelID: "gpt-5.5",
            error: { statusCode: 503, message: "Service unavailable" },
          },
        },
      })

      expect(decisionStates).toHaveLength(1)
      expect(scheduledCallback).toBeDefined()

      await scheduledCallback?.()

      expect(showToast).toHaveBeenCalledTimes(1)
      expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("openai_taobao")
      expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("attempts: 1")
      expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("elapsed: 30000ms")
      expect(showToast.mock.calls[0]?.[0]?.body?.message).toContain("last error: provider_unavailable")
      expect(readWorkStopDetail(directory)).toMatchObject({
        reason: "provider_exhausted",
        exhausted_provider: "openai_taobao",
        retry_attempts: 1,
        retry_elapsed_ms: 30_000,
        last_error: "provider_unavailable",
      })
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

})
