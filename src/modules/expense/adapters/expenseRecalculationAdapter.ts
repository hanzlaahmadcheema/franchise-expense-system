import type { MasterRecalculationAdapter, MasterRefreshProgress, MasterRefreshResult } from "../../../shared/types/dayControl.types";

type ExpenseRecalculationAdapterInput = {
  monthId: string;
  canRun: boolean;
  disabledReason?: string;
  run: (emit: (progress: MasterRefreshProgress) => void) => Promise<MasterRefreshResult>;
};

export function createExpenseRecalculationAdapter({
  monthId,
  canRun,
  disabledReason,
  run
}: ExpenseRecalculationAdapterInput): MasterRecalculationAdapter {
  return {
    moduleKey: "expense",
    monthId,
    label: "Expense",
    canRun: () => canRun,
    disabledReason: () => disabledReason,
    run
  };
}
