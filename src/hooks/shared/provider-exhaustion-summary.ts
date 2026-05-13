import { pauseWork } from "../../features/boulder-state/storage"

type ExhaustionSummaryInput = {
  directory: string
  sessionID: string
  providerID?: string
  retryAttempts: number
  retryElapsedMs?: number
  lastError?: string
  terminalReason: string
  summaryKeyStore: { current?: string }
  showToast: (input: {
    body: {
      title: string
      message: string
      variant: "success" | "error" | "info" | "warning"
      duration: number
    }
  }) => Promise<unknown>
}

export function buildProviderExhaustionSummaryKey(input: {
  sessionID: string
  providerID?: string
  terminalReason: string
}): string {
  return [input.sessionID, input.providerID ?? "unknown", input.terminalReason].join(":")
}

export async function emitProviderExhaustionSummary(input: ExhaustionSummaryInput): Promise<void> {
  const summaryKey = buildProviderExhaustionSummaryKey({
    sessionID: input.sessionID,
    providerID: input.providerID,
    terminalReason: input.terminalReason,
  })

  if (input.summaryKeyStore.current === summaryKey) {
    return
  }

  input.summaryKeyStore.current = summaryKey

  pauseWork(input.directory, "provider_exhausted", {
    exhausted_provider: input.providerID,
    retry_attempts: input.retryAttempts,
    retry_elapsed_ms: input.retryElapsedMs,
    last_error: input.lastError,
  })

  const providerName = input.providerID ?? "unknown"
  const retryElapsedMs = input.retryElapsedMs ?? 0
  const lastError = input.lastError ?? "unknown"

  await input.showToast({
    body: {
      title: "Provider Exhausted",
      message: `${providerName} exhausted after attempts: ${input.retryAttempts}, elapsed: ${retryElapsedMs}ms, last error: ${lastError}, terminal reason: ${input.terminalReason}`,
      variant: "error",
      duration: 8000,
    },
  }).catch(() => {})
}
