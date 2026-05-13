const { afterEach, beforeEach, describe, expect, mock, test } = require("bun:test")
const { existsSync, mkdirSync, rmSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { randomUUID } = require("node:crypto")
const { createToolExecuteBeforeHandler } = require("./tool-execute-before")
const { createToolRegistry } = require("./tool-registry")
const { builtinTools } = require("../tools")
const { resetStorageClient } = require("../tools/session-manager/storage")
const {
  appendSessionIdForWork,
  createBoulderState,
  getWorkByPlanName,
  pauseWork,
  readBoulderState,
  resumeWork,
  writeBoulderState,
} = require("../features/boulder-state")

describe("createToolExecuteBeforeHandler", () => {
  let testDirectory = ""

  beforeEach(() => {
    testDirectory = join(tmpdir(), `tool-execute-before-${randomUUID()}`)
    if (!existsSync(testDirectory)) {
      mkdirSync(testDirectory, { recursive: true })
    }
  })

  afterEach(() => {
    if (testDirectory && existsSync(testDirectory)) {
      rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  test("does not execute subagent question blocker hook for question tool", async () => {
    //#given
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
        },
      },
    }

    const hooks = {
      subagentQuestionBlocker: {
        "tool.execute.before": async () => {
          throw new Error("subagentQuestionBlocker should not run")
        },
      },
    }

    const handler = createToolExecuteBeforeHandler({ ctx, hooks })
    const input = { tool: "question", sessionID: "ses_sub", callID: "call_1" }
    const output = { args: { questions: [] } as Record<string, unknown> }

    //#when
    const run = handler(input, output)

    //#then
    await expect(run).resolves.toBeUndefined()
  })

  test("triggers session notification hook for question tools", async () => {
    let called = false
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
        },
      },
    }

    const hooks = {
      sessionNotification: async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
        called = true
        expect(input.event.type).toBe("tool.execute.before")
        expect(input.event.properties?.sessionID).toBe("ses_q")
        expect(input.event.properties?.tool).toBe("question")
      },
    }

    const handler = createToolExecuteBeforeHandler({ ctx, hooks })
    const input = { tool: "question", sessionID: "ses_q", callID: "call_q" }
    const output = { args: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] } as Record<string, unknown> }

    await handler(input, output)

    expect(called).toBe(true)
  })

  test("does not trigger session notification hook for non-question tools", async () => {
    let called = false
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
        },
      },
    }

    const hooks = {
      sessionNotification: async () => {
        called = true
      },
    }

    const handler = createToolExecuteBeforeHandler({ ctx, hooks })

    await handler(
      { tool: "bash", sessionID: "ses_b", callID: "call_b" },
      { args: { command: "pwd" } as Record<string, unknown> },
    )

    expect(called).toBe(false)
  })

  test("runs compaction todo preserver before hook for todowrite", async () => {
    //#given
    let called = false
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
        },
      },
    }
    const preservedTodos = [
      { content: "Preserved detailed task", status: "pending", priority: "high" },
    ]
    const hooks = {
      compactionTodoPreserver: {
        "tool.execute.before": async (
          input: { tool: string; sessionID: string; callID: string },
          output: { args: Record<string, unknown> },
        ) => {
          called = true
          expect(input.tool).toBe("todowrite")
          output.args.todos = preservedTodos
        },
      },
    }
    const handler = createToolExecuteBeforeHandler({ ctx, hooks })
    const output = { args: { todos: [] } as Record<string, unknown> }

    //#when
    await handler({ tool: "todowrite", sessionID: "ses_compact", callID: "call_todo" }, output)

    //#then
    expect(called).toBe(true)
    expect(output.args.todos).toBe(preservedTodos)
  })

  describe("task tool subagent_type normalization", () => {
    const emptyHooks = {}

    function createCtxWithSessionMessages(messages: Array<{ info?: { agent?: string; role?: string } }> = []) {
      return {
        client: {
          session: {
            messages: async () => ({ data: messages }),
          },
        },
      }
    }

    test("sets subagent_type to sisyphus-junior when category is provided without subagent_type", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { category: "quick", description: "Test" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("sisyphus-junior")
    })

    test("preserves existing subagent_type when explicitly provided", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { subagent_type: "plan", description: "Plan test" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("plan")
    })

    test("preserves explicit subagent_type when category is also provided", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { category: "quick", subagent_type: "oracle", description: "Test" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("oracle")
    })

    test("resolves subagent_type from session first message when task_id is provided without subagent_type", async () => {
      //#given
      const ctx = createCtxWithSessionMessages([
        { info: { role: "user" } },
        { info: { role: "assistant", agent: "explore" } },
        { info: { role: "assistant", agent: "oracle" } },
      ])
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { task_id: "ses_abc123", description: "Continue task", prompt: "fix it" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("explore")
    })

    test("normalizes task_id into the canonical resume argument", async () => {
      //#given
      const ctx = createCtxWithSessionMessages([
        { info: { role: "assistant", agent: "oracle" } },
      ])
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { task_id: "ses_resume_123", description: "Continue task", prompt: "fix it" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.task_id).toBe("ses_resume_123")
      expect(output.args.subagent_type).toBe("oracle")
    })

    test("falls back to 'continue' when session has no agent info", async () => {
      //#given
      const ctx = createCtxWithSessionMessages([
        { info: { role: "user" } },
        { info: { role: "assistant" } },
      ])
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { task_id: "ses_abc123", description: "Continue task", prompt: "fix it" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("continue")
    })

    test("preserves subagent_type when task_id is provided with explicit subagent_type", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { task_id: "ses_abc123", subagent_type: "explore", description: "Continue explore" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("explore")
    })

    test("does not modify args for non-task tools", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "bash", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { command: "ls" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBeUndefined()
    })

    test("does not set subagent_type when neither category nor task_id is provided and subagent_type is present", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { subagent_type: "oracle", description: "Oracle task" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("oracle")
    })
  })

  describe("stop-continuation boulder pause semantics", () => {
    test("pauses active work instead of deleting boulder state", async () => {
      // given
      const state = createBoulderState(join(testDirectory, ".sisyphus", "plans", "plan-a.md"), "ses_parent", "atlas")
      writeBoulderState(testDirectory, state)
      const cancelAllCountdowns = mock(() => {})
      const cancelLoop = mock(() => {})
      const stop = mock(() => {})
      const handler = createToolExecuteBeforeHandler({
        ctx: { directory: testDirectory, client: { session: { messages: async () => ({ data: [] }) } } },
        hooks: {
          stopContinuationGuard: { stop, isStopped: () => false, clear: () => {} },
          todoContinuationEnforcer: { cancelAllCountdowns },
          ralphLoop: { cancelLoop },
        },
      })

      // when
      await handler(
        { tool: "skill", sessionID: "ses_parent", callID: "call-stop" },
        { args: { name: "/stop-continuation" } },
      )

      // then
      expect(stop).toHaveBeenCalledWith("ses_parent")
      expect(cancelAllCountdowns).toHaveBeenCalledTimes(1)
      expect(cancelLoop).toHaveBeenCalledWith("ses_parent")
      expect(readBoulderState(testDirectory)?.status).toBe("paused_by_user")
      expect(readBoulderState(testDirectory)?.active_work_id).toBeTruthy()
    })

    test("resumes paused work on explicit /start-work without reconstructing lineage", async () => {
      // given
      const state = createBoulderState(join(testDirectory, ".sisyphus", "plans", "plan-b.md"), "ses_parent", "atlas")
      writeBoulderState(testDirectory, state)
      const work = getWorkByPlanName(testDirectory, "plan-b")
      expect(work).not.toBeNull()
      appendSessionIdForWork(testDirectory, work.work_id, "ses_child", "appended")
      pauseWork(testDirectory, "paused_by_user")

      const clear = mock(() => {})
      const handler = createToolExecuteBeforeHandler({
        ctx: { directory: testDirectory, client: { session: { messages: async () => ({ data: [] }) } } },
        hooks: {
          stopContinuationGuard: { stop: () => {}, isStopped: () => true, clear },
        },
      })

      // when
      await handler(
        { tool: "skill", sessionID: "ses_parent", callID: "call-start" },
        { args: { name: "/start-work" } },
      )

      // then
      const resumed = readBoulderState(testDirectory)
      expect(clear).toHaveBeenCalledWith("ses_parent")
      expect(resumed?.status).toBe("active")
      expect(resumed?.session_ids).toEqual(expect.arrayContaining(["ses_parent", "ses_child"]))
      expect(resumed?.active_work_id).toBe(work.work_id)
    })

    test("stops every tracked work session so a late child cannot resume continuation from stale in-memory state", async () => {
      // given
      const state = createBoulderState(join(testDirectory, ".sisyphus", "plans", "plan-c.md"), "ses_parent", "atlas")
      writeBoulderState(testDirectory, state)
      const work = getWorkByPlanName(testDirectory, "plan-c")
      expect(work).not.toBeNull()
      appendSessionIdForWork(testDirectory, work.work_id, "ses_child", "appended")

      const stop = mock(() => {})
      const handler = createToolExecuteBeforeHandler({
        ctx: { directory: testDirectory, client: { session: { messages: async () => ({ data: [] }) } } },
        hooks: {
          stopContinuationGuard: { stop, isStopped: () => false, clear: () => {} },
          todoContinuationEnforcer: { cancelAllCountdowns: () => {} },
          ralphLoop: { cancelLoop: () => {} },
        },
      })

      // when
      await handler(
        { tool: "skill", sessionID: "ses_parent", callID: "call-stop-all" },
        { args: { name: "/stop-continuation" } },
      )

      // then
      expect(stop.mock.calls.map((call) => call[0]).sort()).toEqual(["ses_child", "ses_parent"])
      expect(readBoulderState(testDirectory)?.status).toBe("paused_by_user")
    })
  })
})

describe("createToolRegistry", () => {
  afterEach(() => {
    resetStorageClient()
  })

  function createRegistryInput(overrides = {}) {
    return {
      ctx: {
        directory: process.cwd(),
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      pluginConfig: {
        ...overrides,
      },
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
      },
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
    }
  }

  describe("#given hashline_edit is undefined", () => {
    describe("#when creating tool registry", () => {
      test("#then should not register edit tool", () => {
        const result = createToolRegistry(createRegistryInput())

        expect(result.filteredTools.edit).toBeUndefined()
      })
    })
  })

  describe("#given hashline_edit is true", () => {
    describe("#when creating tool registry", () => {
      test("#then should register edit tool", () => {
        const result = createToolRegistry(
          createRegistryInput({
            hashline_edit: true,
          }),
        )

        expect(result.filteredTools.edit).toBeDefined()
      })
    })
  })

  describe("#given max_tools is lower than or equal to builtin tool count", () => {
    describe("#when creating the tool registry", () => {
      test("#then it trims to the exact configured cap", () => {
        const result = createToolRegistry(
          createRegistryInput({
            experimental: { max_tools: Object.keys(builtinTools).length },
          }),
        )

        expect(Object.keys(result.filteredTools)).toHaveLength(Object.keys(builtinTools).length)
      })
    })
  })

  describe("#given max_tools is set below the full plugin tool count", () => {
    describe("#when creating the tool registry", () => {
      test("#then it enforces the exact cap deterministically", () => {
        const result = createToolRegistry(
          createRegistryInput({
            experimental: { max_tools: 10 },
          }),
        )

        expect(Object.keys(result.filteredTools)).toHaveLength(10)
      })

      test("#then it keeps the task tool when lower-priority tools can satisfy the cap", () => {
        const result = createToolRegistry(
          createRegistryInput({
            experimental: { max_tools: 10 },
          }),
        )

        expect(result.filteredTools.task).toBeDefined()
      })
    })
  })
})

export {}
