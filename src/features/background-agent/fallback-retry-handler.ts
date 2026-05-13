import type { BackgroundTask, LaunchInput } from "./types"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { ConcurrencyManager } from "./concurrency"
import type { OpencodeClient, QueueItem } from "./constants"
import { getWorkForSession, isWorkStoppedOrExhausted } from "../boulder-state"
import * as loggerModule from "../../shared/logger"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import * as modelErrorClassifier from "../../shared/model-error-classifier"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"
import { abortWithTimeout } from "./abort-with-timeout"
import { ensureCurrentAttempt, scheduleRetryAttempt } from "./attempt-lifecycle"
import { decidePacedRetry, isPacedRetryProvider } from "../../shared/provider-retry-governor"

function canonicalizeModelID(modelID: string): string {
  return modelID.toLowerCase().replace(/\./g, "-")
}

function hasStoppedTrackedWork(input: {
  parentDirectory?: string
  parentSessionId: string
  taskId: string
  source: string
}): boolean {
  if (!input.parentDirectory) {
    return false
  }

  const trackedWork = getWorkForSession(input.parentDirectory, input.parentSessionId)
  if (!trackedWork?.status || !isWorkStoppedOrExhausted(trackedWork.status)) {
    return false
  }

  loggerModule.log("[background-agent] Skip fallback requeue because tracked work stopped", {
    taskId: input.taskId,
    source: input.source,
    parentSessionId: input.parentSessionId,
    trackedStatus: trackedWork.status,
  })
  return true
}

function selectReachableProvider(
  entry: FallbackEntry,
  preferredProviderID: string | undefined,
  connectedSet: Set<string> | null,
): string {
  if (connectedSet) {
    for (const provider of entry.providers) {
      if (connectedSet.has(provider.toLowerCase())) {
        return provider
      }
    }

    if (preferredProviderID && connectedSet.has(preferredProviderID.toLowerCase())) {
      return preferredProviderID
    }
  }

  return modelErrorClassifier.selectFallbackProvider(entry.providers, preferredProviderID)
}

export async function tryFallbackRetry(args: {
  task: BackgroundTask
  errorInfo: { name?: string; message?: string }
  source: string
  concurrencyManager: ConcurrencyManager
  client: OpencodeClient
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  queuesByKey: Map<string, QueueItem[]>
  parentDirectory?: string
  processKey: (key: string) => void
  onRetrying?: (details: {
    task: BackgroundTask
    source: string
    previousSessionID?: string
    failedModel?: string
    failedError?: string
    nextModel: string
  }) => void
}): Promise<boolean> {
  const { task, errorInfo, source, concurrencyManager, client, idleDeferralTimers, queuesByKey, processKey, onRetrying, parentDirectory } = args
  const fallbackChain = task.fallbackChain
  const canRetry =
    modelErrorClassifier.shouldRetryError(errorInfo) &&
    fallbackChain &&
    fallbackChain.length > 0 &&
    modelErrorClassifier.hasMoreFallbacks(fallbackChain, task.attemptCount ?? 0)

  if (!canRetry) return false

  const attemptCount = task.attemptCount ?? 0
  const providerModelsCache = connectedProvidersCache.readProviderModelsCache()
  const connectedProviders = providerModelsCache?.connected ?? connectedProvidersCache.readConnectedProvidersCache()
  const connectedSet = connectedProviders ? new Set(connectedProviders.map(p => p.toLowerCase())) : null
  const preferredProvider = task.model?.providerID?.toLowerCase()

  const isReachable = (entry: FallbackEntry): boolean => {
    if (!connectedSet) return true
    if (entry.providers.some((provider) => connectedSet.has(provider.toLowerCase()))) {
      return true
    }
    return preferredProvider ? connectedSet.has(preferredProvider) : false
  }

  let selectedAttemptCount = attemptCount
  let nextFallback: FallbackEntry | undefined
  let nextProviderID: string | undefined
  while (fallbackChain && selectedAttemptCount < fallbackChain.length) {
    const candidate = modelErrorClassifier.getNextFallback(fallbackChain, selectedAttemptCount)
    if (!candidate) break
    selectedAttemptCount++
    if (!isReachable(candidate)) {
      loggerModule.log("[background-agent] Skipping unreachable fallback:", {
        taskId: task.id,
        source,
        model: candidate.model,
        providers: candidate.providers,
      })
      continue
    }
    const candidateProviderID = selectReachableProvider(candidate, task.model?.providerID, connectedSet)
    const candidateModelID = transformModelForProvider(candidateProviderID, candidate.model)
    const isNoOpFallback =
      !!task.model &&
      candidateProviderID.toLowerCase() === task.model.providerID.toLowerCase() &&
      canonicalizeModelID(candidateModelID) === canonicalizeModelID(task.model.modelID)
    if (isNoOpFallback) {
      loggerModule.log("[background-agent] Skipping no-op fallback:", {
        taskId: task.id,
        source,
        model: candidate.model,
        providers: candidate.providers,
      })
      continue
    }
    nextFallback = candidate
    nextProviderID = candidateProviderID
    break
  }
  if (!nextFallback) return false

  const providerID = nextProviderID ?? selectReachableProvider(nextFallback, task.model?.providerID, connectedSet)

  loggerModule.log("[background-agent] Retryable error, attempting fallback:", {
    taskId: task.id,
    source,
    errorName: errorInfo.name,
    errorMessage: errorInfo.message?.slice(0, 100),
    attemptCount: selectedAttemptCount,
    nextModel: `${providerID}/${nextFallback.model}`,
  })

  if (task.concurrencyKey) {
    concurrencyManager.release(task.concurrencyKey)
    task.concurrencyKey = undefined
  }

  const idleTimer = idleDeferralTimers.get(task.id)
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleDeferralTimers.delete(task.id)
  }

  const previousSessionID = task.sessionId
  const previousModel = task.model

   const pacedProvider = previousModel?.providerID

  const transformedModelId = isPacedRetryProvider(pacedProvider)
    ? (previousModel?.modelID ?? transformModelForProvider(providerID, nextFallback.model))
    : transformModelForProvider(providerID, nextFallback.model)
  const nextModel = {
    providerID: isPacedRetryProvider(pacedProvider) ? previousModel?.providerID ?? providerID : providerID,
    modelID: transformedModelId,
    variant: nextFallback.variant,
  }
  task.attemptCount = selectedAttemptCount
  const failedAttemptID = ensureCurrentAttempt(task, previousModel).attemptId
  const nextAttempt = failedAttemptID
    ? scheduleRetryAttempt(task, failedAttemptID, nextModel, errorInfo.message)
    : undefined
  if (!nextAttempt) {
    return false
  }

  task.queuedAt = new Date()
  task.retryNotification = {
    previousSessionID,
    failedModel: previousModel ? `${previousModel.providerID}/${previousModel.modelID}` : undefined,
    failedError: errorInfo.message,
    nextModel: `${providerID}/${transformedModelId}`,
  }

  onRetrying?.({
    task,
    source,
    previousSessionID,
    failedModel: task.retryNotification.failedModel,
    failedError: errorInfo.message,
    nextModel: `${providerID}/${transformedModelId}`,
  })

  const key = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent
  const queue = queuesByKey.get(key) ?? []
  const retryInput: LaunchInput = {
    description: task.description,
    prompt: task.prompt,
    agent: task.agent,
    parentSessionId: task.parentSessionId,
    parentMessageId: task.parentMessageId,
    parentModel: task.parentModel,
    parentAgent: task.parentAgent,
    parentTools: task.parentTools,
    teamRunId: task.teamRunId,
    model: nextModel,
    fallbackChain: task.fallbackChain,
    category: task.category,
    isUnstableAgent: task.isUnstableAgent,
    onSessionCreated: task.onSessionCreated,
  }

  if (previousSessionID) {
    await abortWithTimeout(client, previousSessionID).catch(() => {})
  }

  if (hasStoppedTrackedWork({
    parentDirectory,
    parentSessionId: task.parentSessionId,
    taskId: task.id,
    source,
  })) {
    return false
  }

  const enqueueRetry = (): void => {
    if (hasStoppedTrackedWork({
      parentDirectory,
      parentSessionId: task.parentSessionId,
      taskId: task.id,
      source,
    })) {
      return
    }

    queue.push({ task, input: retryInput, attemptID: nextAttempt.attemptId })
    queuesByKey.set(key, queue)
    processKey(key)
  }

  if (isPacedRetryProvider(previousModel?.providerID)) {
    const startedAtMs = task.retryWindowStartedAt ? Date.parse(task.retryWindowStartedAt) : Date.now()
    const decision = decidePacedRetry(
      { attemptCount: task.attemptCount ? task.attemptCount - 1 : 0, startedAt: startedAtMs },
      { providerID: previousModel?.providerID },
    )
    task.retryWindowStartedAt = task.retryWindowStartedAt ?? new Date(startedAtMs).toISOString()
    const timer = setTimeout(() => {
      idleDeferralTimers.delete(task.id)
      enqueueRetry()
    }, decision.delayMs)
    idleDeferralTimers.set(task.id, timer)
    return true
  }

  enqueueRetry()
  return true
}
