import type { CreditRow } from "../types/ledger";
import { parseLedgerNumber } from "./formulaEngine";

type CreditDescriptionFields = Pick<
  CreditRow,
  "description" | "loanDescription" | "receiveDescription" | "loan" | "today" | "receive"
>;

export function resolveCreditDescriptions(row: Partial<CreditDescriptionFields>) {
  const hasCanonicalDescription =
    row.loanDescription !== undefined || row.receiveDescription !== undefined;
  const legacyDescription = row.description?.trim() ?? "";
  const loan = parseLedgerNumber(row.loan ?? row.today);
  const receive = parseLedgerNumber(row.receive);

  if (!hasCanonicalDescription && legacyDescription) {
    if (loan !== 0 && receive === 0) {
      return { loanDescription: legacyDescription, receiveDescription: "", legacyDescription: "" };
    }
    if (receive !== 0 && loan === 0) {
      return { loanDescription: "", receiveDescription: legacyDescription, legacyDescription: "" };
    }
  }

  return {
    loanDescription: row.loanDescription ?? "",
    receiveDescription: row.receiveDescription ?? "",
    legacyDescription: loan !== 0 && receive !== 0
      ? legacyDescription
      : ""
  };
}
