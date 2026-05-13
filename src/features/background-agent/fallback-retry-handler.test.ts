import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBoulderState, pauseWork, writeBoulderState } from "../boulder-state"
import * as connectedProvidersCacheModule from "../../shared/connected-providers-cache"
import * as loggerModule from "../../shared/logger"
import * as modelErrorClassifierModule from "../../shared/model-error-classifier"
import * as providerModelIdTransformModule from "../../shared/provider-model-id-transform"

import type { BackgroundTask } from "./types"
import type { ConcurrencyManager } from "./concurrency"
import type { OpencodeClient, QueueItem } from "./constants"
import { tryFallbackRetry } from "./fallback-retry-handler"

let readConnectedProvidersCacheSpy: ReturnType<typeof spyOn<typeof connectedProvidersCacheModule, "readConnectedProvidersCache">>
let readProviderModelsCacheSpy: ReturnType<typeof spyOn<typeof connectedProvidersCacheModule, "readProviderModelsCache">>
let shouldRetryErrorSpy: ReturnType<typeof spyOn<typeof modelErrorClassifierModule, "shouldRetryError">>
let getNextFallbackSpy: ReturnType<typeof spyOn<typeof modelErrorClassifierModule, "getNextFallback">>
let hasMoreFallbacksSpy: ReturnType<typeof spyOn<typeof modelErrorClassifierModule, "hasMoreFallbacks">>
let selectFallbackProviderSpy: ReturnType<typeof spyOn<typeof modelErrorClassifierModule, "selectFallbackProvider">>
let transformModelForProviderSpy: ReturnType<typeof spyOn<typeof providerModelIdTransformModule, "transformModelForProvider">>
let logSpy: ReturnType<typeof spyOn<typeof loggerModule, "log">>

function createDeferredPromise(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolvePromise = () => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: resolvePromise,
  }
}

function createTempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createMockTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "test-task-1",
    description: "test task",
    prompt: "test prompt",
    agent: "sisyphus-junior",
    status: "error",
    parentSessionId: "parent-session-1",
    parentMessageId: "parent-message-1",
    fallbackChain: [
      { model: "fallback-model-1", providers: ["provider-a"], variant: undefined },
      { model: "fallback-model-2", providers: ["provider-b"], variant: undefined },
    ],
    attemptCount: 0,
    concurrencyKey: "provider-a/original-model",
    model: { providerID: "provider-a", modelID: "original-model" },
    ...overrides,
  }
}

function createMockConcurrencyManager(): ConcurrencyManager {
  return {
    release: mock(() => {}),
    acquire: mock(async () => {}),
    getQueueLength: mock(() => 0),
    getActiveCount: mock(() => 0),
  } as never
}

function createMockClient(): {
  client: OpencodeClient
  abortMock: ReturnType<typeof mock>
} {
  const abortMock = mock(async () => ({}))
  return {
    client: {
      session: {
        abort: abortMock,
      },
    } as never,
    abortMock,
  }
}

function createDefaultArgs(taskOverrides: Partial<BackgroundTask> = {}) {
  const processKeyFn = mock(() => {})
  const queuesByKey = new Map<string, QueueItem[]>()
  const idleDeferralTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const concurrencyManager = createMockConcurrencyManager()
  const { client, abortMock } = createMockClient()
  const task = createMockTask(taskOverrides)

  return {
    task,
    errorInfo: { name: "OverloadedError", message: "model overloaded" },
    source: "polling",
    concurrencyManager,
    client,
    abortMock,
    idleDeferralTimers,
    queuesByKey,
    processKey: processKeyFn,
  }
}

describe("tryFallbackRetry", () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    mock.restore()
    logSpy = spyOn(loggerModule, "log").mockImplementation(() => {})
    readConnectedProvidersCacheSpy = spyOn(connectedProvidersCacheModule, "readConnectedProvidersCache").mockReturnValue(null)
    readProviderModelsCacheSpy = spyOn(connectedProvidersCacheModule, "readProviderModelsCache").mockReturnValue(null)
    shouldRetryErrorSpy = spyOn(modelErrorClassifierModule, "shouldRetryError").mockImplementation(() => true)
    getNextFallbackSpy = spyOn(modelErrorClassifierModule, "getNextFallback").mockImplementation(
      (chain: Array<{ model: string }>, attempt: number) => chain[attempt],
    )
    hasMoreFallbacksSpy = spyOn(modelErrorClassifierModule, "hasMoreFallbacks").mockImplementation(
      (chain: Array<{ model: string }>, attempt: number) => attempt < chain.length,
    )
    selectFallbackProviderSpy = spyOn(modelErrorClassifierModule, "selectFallbackProvider").mockImplementation(
      (providers: string[]) => providers[0],
    )
    transformModelForProviderSpy = spyOn(
      providerModelIdTransformModule,
      "transformModelForProvider",
    ).mockImplementation((_provider: string, model: string) => model)
  })

  describe("#given retryable error with fallback chain", () => {
    test("returns true and enqueues retry", async () => {
      const args = createDefaultArgs()

      const result = await tryFallbackRetry(args)

      expect(result).toBe(true)
    })

    test("resets task status to pending", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.status).toBe("pending")
    })

    test("increments attemptCount", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.attemptCount).toBe(1)
    })

    test("updates task model to fallback", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.model?.modelID).toBe("fallback-model-1")
      expect(args.task.model?.providerID).toBe("provider-a")
    })

    test("clears sessionID and startedAt", async () => {
      const args = createDefaultArgs({
        sessionId: "old-session",
        startedAt: new Date(),
      })

      await tryFallbackRetry(args)

      expect(args.task.sessionId).toBeUndefined()
      expect(args.task.startedAt).toBeUndefined()
    })

    test("clears error field", async () => {
      const args = createDefaultArgs({ error: "previous error" })

      await tryFallbackRetry(args)

      expect(args.task.error).toBeUndefined()
    })

    test("sets new queuedAt", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.queuedAt).toBeInstanceOf(Date)
    })

    test("releases concurrency slot", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.concurrencyManager.release).toHaveBeenCalledWith("provider-a/original-model")
    })

    test("clears concurrencyKey after release", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.task.concurrencyKey).toBeUndefined()
    })

    test("aborts existing session", async () => {
      const args = createDefaultArgs({ sessionId: "session-to-abort" })

      await tryFallbackRetry(args)

      expect(args.abortMock).toHaveBeenCalledWith({
        path: { id: "session-to-abort" },
      })
    })

    test("waits for session abort before resolving", async () => {
      const args = createDefaultArgs({ sessionId: "session-to-abort" })
      const deferred = createDeferredPromise()
      args.abortMock.mockImplementationOnce(() => deferred.promise)

      const retryPromise = tryFallbackRetry(args)
      let settled = false
      void retryPromise.then(() => {
        settled = true
      })

      await Promise.resolve()

      expect(settled).toBe(false)

      deferred.resolve()
      await retryPromise

      expect(settled).toBe(true)
    })

    test("adds retry input to queue and calls processKey", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      const key = `${args.task.model!.providerID}/${args.task.model!.modelID}`
      const queue = args.queuesByKey.get(key)
      expect(queue).toBeDefined()
      expect(queue!.length).toBe(1)
      expect(queue![0].task).toBe(args.task)
      expect(args.processKey).toHaveBeenCalledWith(key)
    })

    test("enqueues retry immediately", async () => {
      const args = createDefaultArgs()

      await tryFallbackRetry(args)

      expect(args.processKey).toHaveBeenCalledTimes(1)
      expect(args.queuesByKey.size).toBe(1)
    })

    test("preserves team identity and session callback in retry input", async () => {
      const onSessionCreated = mock(async () => {})
      const args = createDefaultArgs({
        teamRunId: "team-run-1",
        onSessionCreated,
      })

      await tryFallbackRetry(args)

      const key = `${args.task.model!.providerID}/${args.task.model!.modelID}`
      const retryInput = args.queuesByKey.get(key)?.[0]?.input
      expect(retryInput?.teamRunId).toBe("team-run-1")
      expect(retryInput?.onSessionCreated).toBe(onSessionCreated)
    })

    test("finalizes the failed attempt, creates a new pending attempt, and enqueues its explicit attemptID", async () => {
      const args = createDefaultArgs({
        status: "running",
        sessionId: "session-attempt-1",
        startedAt: new Date("2026-04-27T00:00:00.000Z"),
        attempts: [
          {
            attemptId: "attempt-1",
            attemptNumber: 1,
            sessionId: "session-attempt-1",
            providerId: "provider-a",
            modelId: "original-model",
            status: "running",
            startedAt: new Date("2026-04-27T00:00:00.000Z"),
          },
        ],
        currentAttemptID: "attempt-1",
      })

      await tryFallbackRetry(args)

      expect(args.task.attempts).toHaveLength(2)
      expect(args.task.attempts?.[0]).toMatchObject({
        attemptId: "attempt-1",
        sessionId: "session-attempt-1",
        status: "error",
        error: "model overloaded",
      })
      expect(args.task.attempts?.[0]?.completedAt).toBeInstanceOf(Date)

      const nextAttempt = args.task.attempts?.[1]
      expect(nextAttempt).toBeDefined()
      expect(nextAttempt?.attemptNumber).toBe(2)
      expect(nextAttempt?.providerId).toBe("provider-a")
      expect(nextAttempt?.modelId).toBe("fallback-model-1")
      expect(nextAttempt?.status).toBe("pending")

      expect(args.task.currentAttemptID).toBe(nextAttempt?.attemptId)
      expect(args.task.status).toBe("pending")
      expect(args.task.model).toEqual({
        providerID: "provider-a",
        modelID: "fallback-model-1",
        variant: undefined,
      })

      const key = `${args.task.model!.providerID}/${args.task.model!.modelID}`
      const queue = args.queuesByKey.get(key)
      expect(queue).toBeDefined()
      const queuedAttemptID = queue?.[0]?.attemptID
      expect(queuedAttemptID).toBeDefined()
      expect(nextAttempt?.attemptId).toBeDefined()
      expect(queuedAttemptID).toBe(nextAttempt?.attemptId ?? "")
    })
  })

  describe("#given non-retryable error", () => {
    test("returns false when shouldRetryError returns false", async () => {
      shouldRetryErrorSpy.mockImplementation(() => false)
      const args = createDefaultArgs()

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })
  })

  describe("#given no fallback chain", () => {
    test("returns false when fallbackChain is undefined", async () => {
      const args = createDefaultArgs({ fallbackChain: undefined })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })

    test("returns false when fallbackChain is empty", async () => {
      const args = createDefaultArgs({ fallbackChain: [] })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })
  })

  describe("#given exhausted fallbacks", () => {
    test("returns false when attemptCount exceeds chain length", async () => {
      const args = createDefaultArgs({ attemptCount: 5 })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(false)
    })
  })

  describe("#given task without concurrency key", () => {
    test("skips concurrency release", async () => {
      const args = createDefaultArgs({ concurrencyKey: undefined })

      await tryFallbackRetry(args)

      expect(args.concurrencyManager.release).not.toHaveBeenCalled()
    })
  })

  describe("#given task without session", () => {
    test("skips session abort", async () => {
      const args = createDefaultArgs({ sessionId: undefined })

      await tryFallbackRetry(args)

      expect(args.abortMock).not.toHaveBeenCalled()
    })
  })

  describe("#given active idle deferral timer", () => {
    test("clears the timer and removes from map", async () => {
      const args = createDefaultArgs()
      const timerId = setTimeout(() => {}, 10000)
      args.idleDeferralTimers.set("test-task-1", timerId)

      await tryFallbackRetry(args)

      expect(args.idleDeferralTimers.has("test-task-1")).toBe(false)
    })
  })

  describe("#given second attempt", () => {
    test("uses second fallback in chain", async () => {
      const args = createDefaultArgs({ attemptCount: 1 })

      await tryFallbackRetry(args)

      expect(args.task.model?.modelID).toBe("fallback-model-2")
      expect(args.task.attemptCount).toBe(2)
    })
  })

  describe("#given first fallback is a no-op for the current model", () => {
    test("skips the no-op fallback and advances to the next distinct model", async () => {
      const args = createDefaultArgs({
        model: { providerID: "provider-a", modelID: "fallback-model-1" },
        fallbackChain: [
          { model: "fallback-model-1", providers: ["provider-a"], variant: undefined },
          { model: "fallback-model-2", providers: ["provider-b"], variant: undefined },
        ],
      })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(true)
      expect(args.task.model?.providerID).toBe("provider-b")
      expect(args.task.model?.modelID).toBe("fallback-model-2")
      expect(args.task.attemptCount).toBe(2)
    })
  })

  describe("#given disconnected fallback providers with connected preferred provider", () => {
    test("keeps fallback entry and selects connected preferred provider", async () => {
      readProviderModelsCacheSpy.mockReturnValueOnce({ connected: ["provider-a"] } as never)
      readConnectedProvidersCacheSpy.mockReturnValueOnce(["provider-a"])
      selectFallbackProviderSpy.mockImplementationOnce(
        (_providers: string[], preferredProviderID?: string) => preferredProviderID ?? "provider-b",
      )

      const args = createDefaultArgs({
        fallbackChain: [{ model: "fallback-model-1", providers: ["provider-b"], variant: undefined }],
        model: { providerID: "provider-a", modelID: "original-model" },
      })

      const result = await tryFallbackRetry(args)

      expect(result).toBe(true)
      expect(args.task.model?.providerID).toBe("provider-a")
      expect(args.task.model?.modelID).toBe("fallback-model-1")
    })
  })

  describe("#given tracked work stops before requeue", () => {
    test("does not enqueue retry when parent tracked work is paused_by_user", async () => {
      const directory = createTempDirectory("fallback-stop-")

      try {
        const state = createBoulderState(".sisyphus/plans/test-plan.md", "parent-session-1")
        writeBoulderState(directory, state)
        pauseWork(directory, "paused_by_user")

        const args = createDefaultArgs()
        const result = await tryFallbackRetry({
          ...args,
          parentDirectory: directory,
        })

        expect(result).toBe(false)
        expect(args.queuesByKey.size).toBe(0)
        expect(args.processKey).not.toHaveBeenCalled()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test("does not enqueue paced retry when parent tracked work pauses before delayed callback fires", async () => {
      const directory = createTempDirectory("fallback-paced-stop-")
      const originalSetTimeout = globalThis.setTimeout
      const scheduledCallbacks: Array<() => void> = []

      globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], _delay?: number, ...args: unknown[]) => {
        if (typeof handler === "function") {
          scheduledCallbacks.push(() => handler(...args))
        }
        return Symbol("paced-retry-timer") as ReturnType<typeof setTimeout>
      }) as typeof setTimeout

      try {
        const state = createBoulderState(".sisyphus/plans/test-plan.md", "parent-session-1")
        writeBoulderState(directory, state)

        const args = createDefaultArgs({
          model: { providerID: "openai_taobao", modelID: "original-model" },
          concurrencyKey: "openai_taobao/original-model",
        })
        const result = await tryFallbackRetry({
          ...args,
          parentDirectory: directory,
        })

        expect(result).toBe(true)
        expect(scheduledCallbacks).toHaveLength(1)
        expect(args.queuesByKey.size).toBe(0)
        expect(args.processKey).not.toHaveBeenCalled()
        expect(args.idleDeferralTimers.has("test-task-1")).toBe(true)

        pauseWork(directory, "paused_by_user")
        scheduledCallbacks[0]?.()

        expect(args.idleDeferralTimers.has("test-task-1")).toBe(false)
        expect(args.queuesByKey.size).toBe(0)
        expect(args.processKey).not.toHaveBeenCalled()
      } finally {
        globalThis.setTimeout = originalSetTimeout
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })
})
