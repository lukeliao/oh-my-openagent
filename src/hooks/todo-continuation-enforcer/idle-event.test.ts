/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pauseWork, writeBoulderState } from "../../features/boulder-state"
import { handleSessionIdle } from "./idle-event"
import type { SessionStateStore } from "./session-state"
import type { ContinuationProgressUpdate, SessionState } from "./types"

function createStateStore(): {
  store: SessionStateStore
  resetCalls: string[]
} {
  const state: SessionState = {
    stagnationCount: 0,
    consecutiveFailures: 0,
  }
  const resetCalls: string[] = []
  const progressUpdate: ContinuationProgressUpdate = {
    previousStagnationCount: 0,
    stagnationCount: 0,
    hasProgressed: false,
    progressSource: "none",
  }

  return {
    resetCalls,
    store: {
      getState: () => state,
      getExistingState: () => state,
      startPruneInterval: () => {},
      recordActivity: () => {},
      trackContinuationProgress: () => progressUpdate,
      resetContinuationProgress: (sessionID: string) => {
        resetCalls.push(sessionID)
      },
      cancelCountdown: () => {},
      cleanup: () => {},
      cancelAllCountdowns: () => {},
      shutdown: () => {},
    },
  }
}

describe("handleSessionIdle", () => {
  let testDir = ""

  beforeEach(() => {
    testDir = join(tmpdir(), `todo-idle-stop-${randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it("resets continuation progress once when todos are empty", async () => {
    // given
    const sessionID = "ses_empty_todos"
    const { store, resetCalls } = createStateStore()
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
        },
      },
      directory: "/tmp/test",
    }

    // when
    await handleSessionIdle({
      ctx: ctx as never,
      sessionID,
      sessionStateStore: store,
    })

    // then
    expect(resetCalls).toEqual([sessionID])
  })

  it("resets continuation progress once when every todo is complete", async () => {
    // given
    const sessionID = "ses_completed_todos"
    const { store, resetCalls } = createStateStore()
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
          todo: async () => ({
            data: [
              { id: "todo-1", content: "Ship", status: "completed", priority: "high" },
              { id: "todo-2", content: "Verify", status: "completed", priority: "medium" },
            ],
          }),
        },
      },
      directory: "/tmp/test",
    }

    // when
    await handleSessionIdle({
      ctx: ctx as never,
      sessionID,
      sessionStateStore: store,
    })

    // then
    expect(resetCalls).toEqual([sessionID])
  })

  it("skips countdown when tracked boulder work is paused_by_user", async () => {
    // given
    const sessionID = "ses_paused_boulder"
    const { store } = createStateStore()
    const planPath = join(testDir, "plan.md")
    writeFileSync(planPath, "- [ ] Continue")
    writeBoulderState(testDir, {
      active_plan: planPath,
      started_at: new Date().toISOString(),
      session_ids: [sessionID],
      plan_name: "paused-plan",
      agent: "sisyphus",
    })
    pauseWork(testDir, "paused_by_user")

    const showToast = mock(async () => ({}))
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
          todo: async () => ({
            data: [{ id: "todo-1", content: "Continue", status: "pending", priority: "high" }],
          }),
        },
        tui: { showToast },
      },
      directory: testDir,
    }

    // when
    await handleSessionIdle({
      ctx: ctx as never,
      sessionID,
      sessionStateStore: store,
    })

    // then
    expect(showToast).not.toHaveBeenCalled()
  })
})
