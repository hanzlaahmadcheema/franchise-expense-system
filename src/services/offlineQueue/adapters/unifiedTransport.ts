/**
 * Phase 12B: Unified Domain Adapter Transport
 *
 * Connects the generic MutationQueueManager to the 3 domain adapters:
 * - ExpenseAdapter
 * - StockAdapter
 * - JazzLoadAdapter
 */

import type {
  MutationReadBackFn,
  MutationTransportFn,
  MutationTransportResponse,
  QueuedMutationRecord
} from "../types";
import { ExpenseAdapter } from "./expenseAdapter";
import { StockAdapter } from "./stockAdapter";
import { JazzLoadAdapter } from "./jazzLoadAdapter";

export function createUnifiedTransport(
  expenseAdapter: ExpenseAdapter = new ExpenseAdapter(),
  stockAdapter: StockAdapter = new StockAdapter(),
  jazzLoadAdapter: JazzLoadAdapter = new JazzLoadAdapter()
): MutationTransportFn {
  return async (record: QueuedMutationRecord): Promise<MutationTransportResponse> => {
    switch (record.domain) {
      case "expense":
        return expenseAdapter.execute(record);
      case "stock":
        return stockAdapter.execute(record);
      case "jazzLoad":
        return jazzLoadAdapter.execute(record);
      default:
        throw new Error(`Unknown mutation domain: ${(record as any).domain}`);
    }
  };
}

export function createUnifiedReadBack(
  expenseAdapter: ExpenseAdapter = new ExpenseAdapter(),
  stockAdapter: StockAdapter = new StockAdapter(),
  jazzLoadAdapter: JazzLoadAdapter = new JazzLoadAdapter()
): MutationReadBackFn {
  return async (record: QueuedMutationRecord): Promise<unknown | null> => {
    switch (record.domain) {
      case "expense":
        return expenseAdapter.readBack(record);
      case "stock":
        return stockAdapter.readBack(record);
      case "jazzLoad":
        return jazzLoadAdapter.readBack(record);
      default:
        return null;
    }
  };
}
