/**
 * Phase 12A: Feature Flag for Offline Mutation Queue
 *
 * Defaults strictly to OFF (false).
 * Production behavior remains 100% online-only until explicit enablement in Phase 12E.
 */

let offlineQueueEnabled = false;

export function isOfflineQueueEnabled(): boolean {
  return offlineQueueEnabled;
}

export function setOfflineQueueEnabled(enabled: boolean): void {
  offlineQueueEnabled = enabled;
}

export function resetOfflineQueueFeatureFlag(): void {
  offlineQueueEnabled = false;
}
