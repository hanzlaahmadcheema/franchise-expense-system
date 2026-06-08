import { describe, expect, it } from "vitest";
import { getJazzLoadSaveState } from "./jazzLoadSaveState";
import type { ActiveJazzLoadRates } from "../types/jazzLoad.types";

const activeRates: ActiveJazzLoadRates = {
  mlRate: { id: "ml", name: "ML", type: "ml_addition", percentage: 2.6, active: true, createdBy: "u", createdAt: 1, updatedAt: 1 },
  commission1Rate: { id: "c1", name: "C1", type: "commission1_adjustment", percentage: 0.5, active: true, createdBy: "u", createdAt: 1, updatedAt: 1 },
  commission2Rate: { id: "c2", name: "C2", type: "commission2_payment", percentage: 0.5, active: true, createdBy: "u", createdAt: 1, updatedAt: 1 }
};

const validInput = {
  role: "admin" as const,
  canWriteDaily: true,
  selectedDayFuture: false,
  selectedDayLive: true,
  monthClosed: false,
  dayClosed: false,
  hasDrafts: true,
  activeRates,
  validation: { valid: true, errors: [] }
};

describe("jazzLoadSaveState", () => {
  it("allows unsaved valid current-day changes for owner and admin", () => {
    expect(getJazzLoadSaveState(validInput).canSave).toBe(true);
    expect(getJazzLoadSaveState({ ...validInput, role: "owner", selectedDayLive: false }).canSave).toBe(true);
  });

  it("allows admin previous-day save only when owner-reopened correction access is active", () => {
    expect(getJazzLoadSaveState({
      ...validInput,
      selectedDayLive: false,
      adminCanEditSelectedDay: true
    }).canSave).toBe(true);
    expect(getJazzLoadSaveState({
      ...validInput,
      selectedDayLive: false,
      adminCanEditSelectedDay: false
    }).reason).toBe("Read-only role");
  });

  it("blocks viewer/read-only role, closed days, and future dates with clear reasons", () => {
    expect(getJazzLoadSaveState({ ...validInput, role: "viewer", canWriteDaily: false }).reason).toBe("Read-only role");
    expect(getJazzLoadSaveState({ ...validInput, dayClosed: true }).reason).toBe("Day closed");
    expect(getJazzLoadSaveState({ ...validInput, selectedDayFuture: true }).reason).toBe("Selected date is future");
  });

  it("blocks missing rates, missing DO assignment, invalid data, and active saves", () => {
    expect(getJazzLoadSaveState({
      ...validInput,
      activeRates: { mlRate: null, commission1Rate: null, commission2Rate: null }
    }).reason).toBe("No active rate");
    expect(getJazzLoadSaveState({
      ...validInput,
      validation: { valid: false, errors: ["Missing DO assignment for 301."] }
    }).reason).toBe("Missing DO assignment");
    expect(getJazzLoadSaveState({
      ...validInput,
      validation: { valid: false, errors: ["301 issuance cannot be negative."] }
    }).reason).toBe("Invalid input");
    expect(getJazzLoadSaveState({ ...validInput, saving: true }).reason).toBe("Save already in progress");
  });
});
