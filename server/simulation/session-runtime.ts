export type SimulationRuntimeHandles = {
  release?: () => void;
  selectionRetryTimer?: NodeJS.Timeout;
  selectionRetryResolve?: () => void;
  endTimer?: NodeJS.Timeout;
  progressTimer?: NodeJS.Timeout;
  decisionAbort: AbortController;
  analysisQueued: boolean;
};

export function combinedRelease(...releases: Array<() => void>): () => void {
  return () => {
    const errors: unknown[] = [];
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "일부 실시간 구독을 해제하지 못했습니다.");
    }
  };
}

function releaseWithRetry(release: () => void): void {
  try {
    release();
  } catch (firstError) {
    try {
      release();
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        "실시간 구독 해제 재시도가 실패했습니다.",
      );
    }
  }
}

export function clearSelectionRetry(handles: SimulationRuntimeHandles): void {
  if (handles.selectionRetryTimer !== undefined) clearTimeout(handles.selectionRetryTimer);
  const resolve = handles.selectionRetryResolve;
  handles.selectionRetryTimer = undefined;
  handles.selectionRetryResolve = undefined;
  resolve?.();
}

export type SimulationRuntimeCleanupResult = {
  releaseError?: unknown;
};

export function cleanupSimulationRuntime(
  handles: SimulationRuntimeHandles,
  abortReason: Error,
): SimulationRuntimeCleanupResult {
  clearSelectionRetry(handles);
  if (handles.endTimer !== undefined) clearTimeout(handles.endTimer);
  if (handles.progressTimer !== undefined) clearInterval(handles.progressTimer);
  handles.endTimer = undefined;
  handles.progressTimer = undefined;
  handles.analysisQueued = false;
  if (!handles.decisionAbort.signal.aborted) {
    handles.decisionAbort.abort(abortReason);
  }

  const release = handles.release;
  handles.release = undefined;
  if (!release) return {};
  try {
    releaseWithRetry(release);
    return {};
  } catch (releaseError) {
    return { releaseError };
  }
}
