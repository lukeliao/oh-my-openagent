import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as loggerModule from "../../shared/logger"

import type { OpencodeClient } from "./opencode-client"
import { abortWithTimeout } from "./abort-with-timeout"

let logSpy: ReturnType<typeof spyOn<typeof loggerModule, "log">>

function createClient(abort: (...args: Array<unknown>) => Promise<unknown>): OpencodeClient {
  return {
    session: {
      abort: abort as never,
    },
  } as never
}

describe("abortWithTimeout", () => {
  beforeEach(() => {
    mock.restore()
    logSpy = spyOn(loggerModule, "log").mockImplementation(() => {})
  })

  afterAll(() => {
    mock.restore()
  })

  test("#given abort resolves before timeout #when abortWithTimeout runs #then it returns true", async () => {
    // given
    const abort = mock(async () => ({}))

    // when
    const result = await abortWithTimeout(createClient(abort), "session-1", 10)

    // then
    expect(result).toBe(true)
    expect(abort).toHaveBeenCalledWith({ path: { id: "session-1" } })
    expect(logSpy).not.toHaveBeenCalled()
  })

  test("#given abort hangs indefinitely #when abortWithTimeout runs #then it logs warning and continues", async () => {
    // given
    const abort = mock(() => new Promise<never>(() => {}))

    // when
    const result = await Promise.race([
      abortWithTimeout(createClient(abort), "session-2", 1),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("abort timeout test exceeded wait budget")), 100)
      }),
    ])

    // then
    expect(result).toBe(false)
    expect(logSpy).toHaveBeenCalledWith(
      "[background-agent] Session abort timed out; continuing cleanup:",
      { sessionID: "session-2", timeoutMs: 1 },
    )
  })
})
