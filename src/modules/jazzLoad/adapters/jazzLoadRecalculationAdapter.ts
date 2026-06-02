import type { MasterRecalculationAdapter, MasterRefreshProgress, MasterRefreshResult } from "../../../shared/types/dayControl.types";

type JazzLoadRecalculationAdapterInput = {
  monthId: string;
  canRun: boolean;
  disabledReason?: string;
  run: (emit: (progress: MasterRefreshProgress) => void) => Promise<MasterRefreshResult>;
};

export function createJazzLoadRecalculationAdapter({
  monthId,
  canRun,
  disabledReason,
  run
}: JazzLoadRecalculationAdapterInput): MasterRecalculationAdapter {
  return {
    moduleKey: "jazzLoad",
    monthId,
    label: "Jazz Load",
    canRun: () => canRun,
    disabledReason: () => disabledReason,
    run
  };
}
