import type { MasterRecalculationAdapter, MasterRefreshProgress, MasterRefreshResult } from "../../../shared/types/dayControl.types";

type StockRecalculationAdapterInput = {
  monthId: string;
  canRun: boolean;
  disabledReason?: string;
  run: (emit: (progress: MasterRefreshProgress) => void) => Promise<MasterRefreshResult>;
};

export function createStockRecalculationAdapter({
  monthId,
  canRun,
  disabledReason,
  run
}: StockRecalculationAdapterInput): MasterRecalculationAdapter {
  return {
    moduleKey: "stock",
    monthId,
    label: "Stock Ledger",
    canRun: () => canRun,
    disabledReason: () => disabledReason,
    run
  };
}
