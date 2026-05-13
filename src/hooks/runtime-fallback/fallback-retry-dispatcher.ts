import type { AutoRetryHelpers } from "./auto-retry"
import type { HookDeps, FallbackState } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { prepareFallback } from "./fallback-state"
import { emitProviderExhaustionSummary } from "../shared/provider-exhaustion-summary"
import {
  classifyRetryFailureReason,
  decidePacedRetry,
  extractProviderIdFromModelString,
  extractRetryAfterMs,
  isPacedRetryProvider,
  shouldFastFailPacedRetry,
} from "../../shared/provider-retry-governor"

type DispatchFallbackRetryOptions = {
  sessionID: string
  state: FallbackState
  fallbackModels: string[]
  resolvedAgent?: string
  source: string
  error?: Record<string, unknown>
}

export async function dispatchFallbackRetry(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  options: DispatchFallbackRetryOptions,
): Promise<void> {
  const currentProviderID = extractProviderIdFromModelString(options.state.currentModel)
  if (isPacedRetryProvider(currentProviderID)) {
    const retryStartedAtMs = options.state.retryStartedAtMs ?? Date.now()
    const decision = decidePacedRetry({
      attemptCount: options.state.attemptCount,
      startedAt: retryStartedAtMs,
    }, {
      providerID: currentProviderID,
      retryAfterMs: extractRetryAfterMs(options.error),
    })

    options.state.retryStartedAtMs = retryStartedAtMs
    options.state.attemptCount = decision.nextAttemptCount
    options.state.retryElapsedMs = decision.retryElapsedMs
    options.state.lastError = classifyRetryFailureReason(options.error)
    options.state.pendingFallbackModel = options.state.currentModel

    if (decision.exhausted) {
      options.state.providerExhausted = true
      options.state.providerExhaustedAt = new Date().toISOString()
      options.state.exhaustedProvider = currentProviderID
      log(`[${HOOK_NAME}] Provider retry budget exhausted`, {
        sessionID: options.sessionID,
        source: options.source,
        providerID: currentProviderID,
        retryAttempts: decision.nextAttemptCount,
        retryElapsedMs: decision.retryElapsedMs,
      })
      await emitProviderExhaustionSummary({
        directory: deps.ctx.directory,
        sessionID: options.sessionID,
        providerID: options.state.exhaustedProvider,
        retryAttempts: options.state.attemptCount,
        retryElapsedMs: options.state.retryElapsedMs,
        lastError: options.state.lastError,
        terminalReason: "provider_exhausted",
        summaryKeyStore: {
          get current() {
            return options.state.terminalSummaryKey
          },
          set current(value: string | undefined) {
            options.state.terminalSummaryKey = value
          },
        },
        showToast: deps.ctx.client.tui.showToast,
      })
      return
    }

    if (shouldFastFailPacedRetry(options.error)) {
      options.state.providerExhausted = true
      options.state.providerExhaustedAt = new Date().toISOString()
      options.state.exhaustedProvider = currentProviderID
      log(`[${HOOK_NAME}] Provider retry terminated without delayed retry`, {
        sessionID: options.sessionID,
        source: options.source,
        providerID: currentProviderID,
        retryAttempts: decision.nextAttemptCount,
        retryElapsedMs: decision.retryElapsedMs,
        lastError: options.state.lastError,
      })
      await emitProviderExhaustionSummary({
        directory: deps.ctx.directory,
        sessionID: options.sessionID,
        providerID: options.state.exhaustedProvider,
        retryAttempts: options.state.attemptCount,
        retryElapsedMs: options.state.retryElapsedMs,
        lastError: options.state.lastError,
        terminalReason: "provider_exhausted",
        summaryKeyStore: {
          get current() {
            return options.state.terminalSummaryKey
          },
          set current(value: string | undefined) {
            options.state.terminalSummaryKey = value
          },
        },
        showToast: deps.ctx.client.tui.showToast,
      })
      return
    }

    await helpers.autoRetryWithFallback(
      options.sessionID,
      options.state.currentModel,
      options.resolvedAgent,
      options.source,
      decision.delayMs,
    )
    return
  }

  const result = prepareFallback(
    options.sessionID,
    options.state,
    options.fallbackModels,
    deps.config,
  )

  if (result.success && deps.config.notify_on_fallback) {
    await deps.ctx.client.tui
      .showToast({
        body: {
          title: "Model Fallback",
          message: `Switching to ${result.newModel?.split("/").pop() || result.newModel} for next request`,
          variant: "warning",
          duration: 5000,
        },
      })
      .catch(() => {})
  }

  if (result.success && result.newModel) {
    await helpers.autoRetryWithFallback(
      options.sessionID,
      result.newModel,
      options.resolvedAgent,
      options.source,
    )
    return
  }

  log(`[${HOOK_NAME}] Fallback preparation failed`, {
    sessionID: options.sessionID,
    source: options.source,
    error: result.error,
  })
}
