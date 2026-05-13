import { describe, expect, test } from "bun:test"
import { START_WORK_TEMPLATE } from "./start-work"

describe("start-work template", () => {
  test("should describe start or resume semantics", () => {
    // given - the start-work template

    // when - we check the top-level wording

    // then - it should reflect both entry paths
    expect(START_WORK_TEMPLATE).toContain("starting or resuming")
    expect(START_WORK_TEMPLATE).toContain("start or resume")
  })

  test("should document paused_by_user resume behavior", () => {
    // given - the start-work template

    // when - we inspect the resume contract

    // then - it should mention the persisted paused state and explicit resume path
    expect(START_WORK_TEMPLATE).toContain("paused_by_user")
    expect(START_WORK_TEMPLATE).toContain("explicit `/start-work` resumes it to `active`")
  })
})
