import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundManager, BackgroundTask } from "../../features/background-agent"
import { readContinuationMarker } from "../../features/run-continuation-state"
import {
  createBoulderState,
  pauseWork,
  resumeWork,
  readWorkStopDetail,
  isWorkStoppedOrExhausted,
  isProviderExhausted,
  readBoulderState,
  writeBoulderState,
} from "../../features/boulder-state"
import { createStopContinuationGuardHook } from "./index"

type CancelCall = {
  taskId: string
  options?: Parameters<BackgroundManager["cancelTask"]>[1]
}

describe("stop-continuation-guard", () => {
  const tempDirs: string[] = []

  function createTempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "omo-stop-guard-"))
    tempDirs.push(directory)
    return directory
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const directory = tempDirs.pop()
      if (directory) {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  function createMockPluginInput() {
    return {
      client: {
        tui: {
          showToast: async () => ({}),
        },
      },
      directory: createTempDir(),
    } as unknown as PluginInput
  }

  function createBackgroundTask(status: BackgroundTask["status"], id: string): BackgroundTask {
    return {
      id,
      status,
      description: `${id} description`,
      parentSessionId: "parent-session",
      parentMessageId: "parent-message",
      prompt: "prompt",
      agent: "sisyphus-junior",
    }
  }

  function createMockBackgroundManager(tasks: BackgroundTask[], cancelCalls: CancelCall[]): Pick<BackgroundManager, "getAllDescendantTasks" | "cancelTask"> {
    return {
      getAllDescendantTasks: () => tasks,
      cancelTask: async (taskId: string, options?: Parameters<BackgroundManager["cancelTask"]>[1]) => {
        cancelCalls.push({ taskId, options })
        return true
      },
    }
  }

  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  test("should mark session as stopped", () => {
    // given - a guard hook with no stopped sessions
    const input = createMockPluginInput()
    const guard = createStopContinuationGuardHook(input)
    const sessionID = "test-session-1"

    // when - we stop continuation for the session
    guard.stop(sessionID)

    // then - session should be marked as stopped
    expect(guard.isStopped(sessionID)).toBe(true)

    const marker = readContinuationMarker(input.directory, sessionID)
    expect(marker?.sources.stop?.state).toBe("stopped")
  })

  test("should return false for non-stopped sessions", () => {
    // given - a guard hook with no stopped sessions
    const guard = createStopContinuationGuardHook(createMockPluginInput())

    // when - we check a session that was never stopped

    // then - it should return false
    expect(guard.isStopped("non-existent-session")).toBe(false)
  })

  test("should clear stopped state for a session", () => {
    // given - a session that was stopped
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const sessionID = "test-session-2"
    guard.stop(sessionID)

    // when - we clear the session
    guard.clear(sessionID)

    // then - session should no longer be stopped
    expect(guard.isStopped(sessionID)).toBe(false)
  })

  test("should handle multiple sessions independently", () => {
    // given - multiple sessions with different stop states
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const session1 = "session-1"
    const session2 = "session-2"
    const session3 = "session-3"

    // when - we stop some sessions but not others
    guard.stop(session1)
    guard.stop(session2)

    // then - each session has its own state
    expect(guard.isStopped(session1)).toBe(true)
    expect(guard.isStopped(session2)).toBe(true)
    expect(guard.isStopped(session3)).toBe(false)
  })

  test("should clear session on session.deleted event", async () => {
    // given - a session that was stopped
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const sessionID = "test-session-3"
    guard.stop(sessionID)

    // when - session is deleted
    await guard.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionID } },
      },
    })

    // then - session should no longer be stopped (cleaned up)
    expect(guard.isStopped(sessionID)).toBe(false)
  })

  test("should not affect other sessions on session.deleted", async () => {
    // given - multiple stopped sessions
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const session1 = "session-keep"
    const session2 = "session-delete"
    guard.stop(session1)
    guard.stop(session2)

    // when - one session is deleted
    await guard.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: session2 } },
      },
    })

    // then - other session should remain stopped
    expect(guard.isStopped(session1)).toBe(true)
    expect(guard.isStopped(session2)).toBe(false)
  })

  test("should NOT clear stopped state on new user message (chat.message)", async () => {
    // given - a session that was stopped
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const sessionID = "test-session-4"
    guard.stop(sessionID)
    expect(guard.isStopped(sessionID)).toBe(true)

    // when - user sends a new message
    await guard["chat.message"]({ sessionID })

    // then - stop state should persist (not cleared by user messages)
    // Stop is only cleared by explicit work-starting commands (/start-work, /ralph-loop, /ulw-loop)
    // or session deletion. This prevents /stop-continuation from being ineffective.
    expect(guard.isStopped(sessionID)).toBe(true)
  })

  test("should persist stop state across multiple user messages", async () => {
    // given - a session that was stopped
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const sessionID = "test-session-persist"
    guard.stop(sessionID)

    // when - user sends multiple messages
    await guard["chat.message"]({ sessionID })
    await guard["chat.message"]({ sessionID })
    await guard["chat.message"]({ sessionID })

    // then - stop state remains active
    expect(guard.isStopped(sessionID)).toBe(true)
  })

  test("should clear stop state only via explicit clear() call", () => {
    // given - a session that was stopped
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const sessionID = "test-session-explicit-clear"
    guard.stop(sessionID)
    expect(guard.isStopped(sessionID)).toBe(true)

    // when - clear is called (simulating /start-work or /ralph-loop)
    guard.clear(sessionID)

    // then - stop state is cleared
    expect(guard.isStopped(sessionID)).toBe(false)
  })

  test("should not affect non-stopped sessions on chat.message", async () => {
    // given - a session that was never stopped
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    const sessionID = "test-session-5"

    // when - user sends a message (session was never stopped)
    await guard["chat.message"]({ sessionID })

    // then - should not throw and session remains not stopped
    expect(guard.isStopped(sessionID)).toBe(false)
  })

  test("should handle undefined sessionID in chat.message", async () => {
    // given - a guard with a stopped session
    const guard = createStopContinuationGuardHook(createMockPluginInput())
    guard.stop("some-session")

    // when - chat.message is called without sessionID
    await guard["chat.message"]({ sessionID: undefined })

    // then - should not throw and stopped session remains stopped
    expect(guard.isStopped("some-session")).toBe(true)
  })

  test("should cancel only running and pending background tasks on stop", async () => {
    // given - a background manager with mixed task statuses
    const cancelCalls: CancelCall[] = []
    const backgroundManager = createMockBackgroundManager(
      [
        createBackgroundTask("running", "task-running"),
        createBackgroundTask("pending", "task-pending"),
        createBackgroundTask("completed", "task-completed"),
      ],
      cancelCalls,
    )
    const guard = createStopContinuationGuardHook(createMockPluginInput(), {
      backgroundManager,
    })

    // when - stop continuation is triggered
    guard.stop("test-session-bg")
    await flushMicrotasks()

    // then - only running and pending tasks are cancelled
    expect(cancelCalls).toHaveLength(2)
    expect(cancelCalls[0]?.taskId).toBe("task-running")
    expect(cancelCalls[0]?.options?.abortSession).toBe(true)
    expect(cancelCalls[1]?.taskId).toBe("task-pending")
    expect(cancelCalls[1]?.options?.abortSession).toBe(false)
  })
})

describe("unified stop state — chat vs resume", () => {
  const tempDirs: string[] = []

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "omo-stop-chat-resume-"))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test("ordinary chat does not clear paused_by_user state", async () => {
    // given - work paused via the unified model
    const dir = createTempDir()
    const planPath = join(dir, ".sisyphus", "plans", "chat-test.md")
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, "# Chat Test\n- [ ] Task 1\n")
    createBoulderState(planPath, "session-chat", "sisyphus")
    writeBoulderState(dir, createBoulderState(planPath, "session-chat"))
    const paused = pauseWork(dir, "paused_by_user")
    expect(paused?.status).toBe("paused_by_user")

    // when - user sends a chat message (the guard hook's chat.message is a no-op)
    const guard = createStopContinuationGuardHook({
      client: { tui: { showToast: async () => ({}) } },
      directory: dir,
    } as unknown as PluginInput)
    await guard["chat.message"]({ sessionID: "session-chat" })

    // then - paused state must persist on disk
    const state = readBoulderState(dir)
    expect(state?.status).toBe("paused_by_user")
    expect(isWorkStoppedOrExhausted(state?.status ?? "active")).toBe(true)
    expect(readWorkStopDetail(dir)?.reason).toBe("paused_by_user")
  })

  test("explicit resumeWork clears paused state", () => {
    // given - work paused via the unified model
    const dir = createTempDir()
    const planPath = join(dir, ".sisyphus", "plans", "resume-test.md")
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, "# Resume Test\n- [ ] Task 1\n")
    createBoulderState(planPath, "session-resume", "sisyphus")
    writeBoulderState(dir, createBoulderState(planPath, "session-resume"))
    const paused = pauseWork(dir, "paused_by_user")
    expect(paused?.status).toBe("paused_by_user")

    // when - explicit resume (simulating /start-work clear path)
    const resumed = resumeWork(dir)

    // then - work returns to active
    expect(resumed?.status).toBe("active")
    expect(resumed?.stop_detail).toBeUndefined()
    expect(isWorkStoppedOrExhausted(resumed?.status ?? "abandoned")).toBe(false)
  })

  test("paused_by_user and provider_exhausted are distinguishable", () => {
    // given - paused by user
    const dir = createTempDir()
    const planPath = join(dir, ".sisyphus", "plans", "distinguish-test.md")
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, "# Distinguish Test\n- [ ] Task 1\n")
    createBoulderState(planPath, "session-dist", "sisyphus")
    writeBoulderState(dir, createBoulderState(planPath, "session-dist"))

    // when - paused by user
    pauseWork(dir, "paused_by_user")
    const userPausedState = readBoulderState(dir)

    // then - user pause vs provider exhaustion are distinct
    expect(userPausedState?.status).toBe("paused_by_user")
    expect(isWorkStoppedOrExhausted("paused_by_user")).toBe(true)
    expect(isProviderExhausted("paused_by_user")).toBe(false)

    // when - provider exhausted
    pauseWork(dir, "provider_exhausted", {
      exhausted_provider: "openai_taobao",
      retry_attempts: 3,
    })
    const exhaustedState = readBoulderState(dir)

    // then
    expect(exhaustedState?.status).toBe("provider_exhausted")
    expect(isWorkStoppedOrExhausted("provider_exhausted")).toBe(true)
    expect(isProviderExhausted("provider_exhausted")).toBe(true)
    expect(exhaustedState?.stop_detail?.exhausted_provider).toBe("openai_taobao")
  })

  test("multiple pause/resume cycles preserve state integrity", () => {
    // given - active work
    const dir = createTempDir()
    const planPath = join(dir, ".sisyphus", "plans", "cycle-test.md")
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, "# Cycle Test\n- [ ] Task 1\n")
    createBoulderState(planPath, "session-cycle", "sisyphus")
    writeBoulderState(dir, createBoulderState(planPath, "session-cycle"))

    // when - cycle 1: pause → resume
    expect(pauseWork(dir, "paused_by_user")?.status).toBe("paused_by_user")
    expect(resumeWork(dir)?.status).toBe("active")

    // when - cycle 2: pause → resume
    expect(pauseWork(dir, "paused_by_user")?.status).toBe("paused_by_user")
    expect(resumeWork(dir)?.status).toBe("active")

    // when - cycle 3: pause with provider exhaustion
    const p3 = pauseWork(dir, "provider_exhausted", {
      exhausted_provider: "openai_taobao",
      retry_attempts: 5,
    })
    expect(p3?.status).toBe("provider_exhausted")
    expect(p3?.stop_detail?.retry_attempts).toBe(5)

    // then - resume clears exhaustion and returns to active
    const r3 = resumeWork(dir)
    expect(r3?.status).toBe("active")
    expect(r3?.stop_detail).toBeUndefined()
  })
})
