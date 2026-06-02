import type { MasterRecalculationAdapter, MasterRefreshProgress, MasterRefreshResult } from "../types/dayControl.types";

type RunMasterRecalculationOptions = {
  adapter: MasterRecalculationAdapter;
  confirm?: (adapter: MasterRecalculationAdapter) => boolean;
  onStart?: (adapter: MasterRecalculationAdapter) => void;
  onProgress?: (progress: MasterRefreshProgress) => void;
  onComplete?: (result: MasterRefreshResult) => void;
  onError?: (error: Error) => void;
};

export async function runMasterRecalculation({
  adapter,
  confirm,
  onStart,
  onProgress,
  onComplete,
  onError
}: RunMasterRecalculationOptions): Promise<MasterRefreshResult | null> {
  if (!adapter.canRun()) {
    throw new Error(adapter.disabledReason?.() ?? "Master refresh is not available for this module.");
  }
  if (confirm && !confirm(adapter)) return null;

  onStart?.(adapter);
  const emit = (progress: MasterRefreshProgress) => onProgress?.(progress);
  try {
    emit({ step: "Starting master refresh..." });
    const result = await adapter.run(emit);
    onComplete?.(result);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Master refresh failed.");
    onError?.(error);
    throw error;
  }
}
