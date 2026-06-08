// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoSaveEntry } from "./useAutoSaveEntry";

describe("useAutoSaveEntry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("autosaves dirty valid changes after debounce and clears pending state on success", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ amount }) => useAutoSaveEntry({
        data: { amount },
        enabled: true,
        disabled: false,
        debounceMs: 100,
        savedStatus: "saved",
        validate: () => true,
        save
      }),
      { initialProps: { amount: 0 } }
    );

    expect(result.current.autoSaveStatus).toBe("saved");

    rerender({ amount: 50 });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.autoSaveStatus).toBe("typing");
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledWith({ amount: 50 });
    expect(result.current.autoSaveStatus).toBe("saved");
    expect(result.current.hasPendingAutoSave).toBe(false);
  });

  it("keeps invalid dirty changes unsaved with a clear validation message", async () => {
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ amount }) => useAutoSaveEntry({
        data: { amount },
        enabled: true,
        disabled: false,
        debounceMs: 100,
        validate: () => ["Invalid input"],
        save
      }),
      { initialProps: { amount: 0 } }
    );

    rerender({ amount: -1 });

    await waitFor(() => expect(result.current.autoSaveStatus).toBe("unsaved"));
    expect(result.current.autoSaveError).toBe("Invalid input");
    expect(save).not.toHaveBeenCalled();
  });

  it("autosaves an unchanged dirty draft when validation later becomes valid", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ amount, valid }) => useAutoSaveEntry({
        data: { amount },
        enabled: true,
        disabled: false,
        debounceMs: 100,
        savedStatus: "saved",
        validationKey: valid,
        validate: () => valid || ["Missing DO assignment"],
        save
      }),
      { initialProps: { amount: 0, valid: false } }
    );

    rerender({ amount: 25, valid: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.autoSaveStatus).toBe("unsaved");
    expect(save).not.toHaveBeenCalled();

    rerender({ amount: 25, valid: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.autoSaveStatus).toBe("typing");
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(save).toHaveBeenCalledWith({ amount: 25 });
    expect(result.current.autoSaveStatus).toBe("saved");
  });

  it("cancels a pending autosave immediately when the day becomes closed", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ amount, disabled }) => useAutoSaveEntry({
        data: { amount },
        enabled: true,
        disabled,
        debounceMs: 100,
        savedStatus: "saved",
        save
      }),
      { initialProps: { amount: 0, disabled: false } }
    );

    rerender({ amount: 50, disabled: false });
    await act(async () => Promise.resolve());
    expect(result.current.autoSaveStatus).toBe("typing");

    rerender({ amount: 50, disabled: true });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(save).not.toHaveBeenCalled();
    expect(result.current.autoSaveStatus).toBe("readOnly");
  });
});
