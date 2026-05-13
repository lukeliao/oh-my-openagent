import { describe, expect, mock, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import { createCommandExecuteBeforeHandler } from "./command-execute-before"
import { createStartWorkHook } from "../hooks/start-work"
import { createBoulderState, pauseWork, readBoulderState, writeBoulderState } from "../features/boulder-state"

describe("createCommandExecuteBeforeHandler", () => {
  function createTestDirectory(): string {
    const directory = join(tmpdir(), `command-execute-before-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    return directory
  }

  test("#given stopped session and /ulw-loop #when command.execute.before runs #then clear is called", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderState(directory, createBoulderState(join(directory, ".sisyphus", "plans", "loop.md"), "ses-stopped", "atlas"))
    pauseWork(directory, "paused_by_user")
    const clear = mock(() => {})
    const isStopped = mock(() => true)
    const startLoop = mock(() => true)
    const handler = createCommandExecuteBeforeHandler({
      directory,
      hooks: {
        ralphLoop: {
          startLoop,
          cancelLoop: mock(() => true),
        },
        stopContinuationGuard: {
          isStopped,
          clear,
        },
      },
    })

    // when
    await handler(
      {
        command: "ulw-loop",
        sessionID: "ses-stopped",
        arguments: "Ship feature",
      },
      {
        parts: [],
      },
    )

    // then
    expect(startLoop).toHaveBeenCalledTimes(1)
    expect(isStopped).toHaveBeenCalledWith("ses-stopped")
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith("ses-stopped")
    expect(readBoulderState(directory)?.status).toBe("active")
    rmSync(directory, { recursive: true, force: true })
  })

  test("#given stopped session and /start-work #when command.execute.before runs #then clear is called", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderState(directory, createBoulderState(join(directory, ".sisyphus", "plans", "work.md"), "ses-stopped", "atlas"))
    pauseWork(directory, "paused_by_user")
    const clear = mock(() => {})
    const isStopped = mock(() => true)
    const startWorkHook = mock(async () => {})
    const handler = createCommandExecuteBeforeHandler({
      directory,
      hooks: {
        startWork: {
          "command.execute.before": startWorkHook,
        },
        stopContinuationGuard: {
          isStopped,
          clear,
        },
      },
    })

    // when
    await handler(
      {
        command: "start-work",
        sessionID: "ses-stopped",
        arguments: "",
      },
      {
        parts: [],
      },
    )

    // then
    expect(startWorkHook).toHaveBeenCalledTimes(1)
    expect(isStopped).toHaveBeenCalledWith("ses-stopped")
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith("ses-stopped")
    expect(readBoulderState(directory)?.status).toBe("active")
    rmSync(directory, { recursive: true, force: true })
  })

  test("#given paused_by_user work and native /start-work #when command.execute.before runs #then start-work hook reads already-resumed state", async () => {
    // given
    const directory = createTestDirectory()
    const planPath = join(directory, ".sisyphus", "plans", "paused-work.md")
    mkdirSync(join(directory, ".sisyphus", "plans"), { recursive: true })
    Bun.write(planPath, "# Plan\n- [ ] Task 1")
    writeBoulderState(directory, createBoulderState(planPath, "ses-stopped", "atlas"))
    pauseWork(directory, "paused_by_user")

    const clear = mock(() => {})
    const isStopped = mock(() => true)
    const observedStatuses: Array<string | undefined> = []
    const startWork = createStartWorkHook({ directory, client: {} } as Parameters<typeof createStartWorkHook>[0])
    const originalStartWork = startWork["command.execute.before"]
    startWork["command.execute.before"] = async (input, output) => {
      observedStatuses.push(readBoulderState(directory)?.status)
      await originalStartWork(input, output)
    }
    const handler = createCommandExecuteBeforeHandler({
      directory,
      hooks: {
        startWork,
        stopContinuationGuard: {
          isStopped,
          clear,
        },
      },
    })
    const output = {
      parts: [{ type: "text", text: "<session-context>ctx</session-context>\nYou are starting a Sisyphus work session." }],
      message: {},
    }

    // when
    await handler(
      {
        command: "start-work",
        sessionID: "ses-stopped",
        arguments: "",
      },
      output,
    )

    // then
    expect(observedStatuses).toEqual(["active"])
    expect(output.parts[0].text).toContain("RESUMING existing work")
    expect(readBoulderState(directory)?.status).toBe("active")
    expect(clear).toHaveBeenCalledWith("ses-stopped")
    rmSync(directory, { recursive: true, force: true })
  })

  test("#given non-stopped session and /ulw-loop #when command.execute.before runs #then clear is not called", async () => {
    // given
    const directory = createTestDirectory()
    const clear = mock(() => {})
    const isStopped = mock(() => false)
    const startLoop = mock(() => true)
    const handler = createCommandExecuteBeforeHandler({
      directory,
      hooks: {
        ralphLoop: {
          startLoop,
          cancelLoop: mock(() => true),
        },
        stopContinuationGuard: {
          isStopped,
          clear,
        },
      },
    })

    // when
    await handler(
      {
        command: "ulw-loop",
        sessionID: "ses-running",
        arguments: "Ship feature",
      },
      {
        parts: [],
      },
    )

    // then
    expect(startLoop).toHaveBeenCalledTimes(1)
    expect(isStopped).toHaveBeenCalledWith("ses-running")
    expect(clear).not.toHaveBeenCalled()
    rmSync(directory, { recursive: true, force: true })
  })
})
