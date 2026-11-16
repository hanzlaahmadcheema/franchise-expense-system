// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { CurrencyInput } from "./CurrencyInput";

describe("CurrencyInput Component", () => {
  it("formats value with commas on blur according to AC-2.1", async () => {
    const handleChange = vi.fn();
    render(<CurrencyInput value={136855} onChange={handleChange} precision={2} />);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("136,855.00");

    // On focus, shows unformatted number for easy typing
    fireEvent.focus(input);
    expect(input.value).toBe("136855");

    // On blur, returns to formatted comma representation
    fireEvent.blur(input);
    expect(input.value).toBe("136,855.00");
  });

  it("updates numeric model when user enters numbers", () => {
    const handleChange = vi.fn();
    const handleValueChange = vi.fn();

    render(
      <CurrencyInput
        onChange={handleChange}
        onValueChange={handleValueChange}
        precision={2}
      />
    );

    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "4500.5" } });
    expect(handleValueChange).toHaveBeenCalledWith(4500.5);

    fireEvent.blur(input);
    expect(input.value).toBe("4,500.50");
  });

  it("strips non-numeric input on paste per AC-2.1", () => {
    const handleChange = vi.fn();
    render(<CurrencyInput onChange={handleChange} precision={2} />);

    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "PKR 55,200.75 ABC!",
      },
    });

    expect(input.value).toBe("55200.75");
    fireEvent.blur(input);
    expect(input.value).toBe("55,200.75");
  });

  it("prevents negative values by default but allows when allowNegative is true", () => {
    const { rerender } = render(<CurrencyInput allowNegative={false} precision={2} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "-1200" } });
    expect(input.value).toBe("1200");

    rerender(<CurrencyInput allowNegative={true} precision={2} />);
    fireEvent.change(input, { target: { value: "-1200" } });
    expect(input.value).toBe("-1200");
  });

  it("displays error message and sets aria-invalid", () => {
    render(
      <CurrencyInput
        id="test-input"
        error="Amount cannot exceed daily cash limit"
        precision={2}
      />
    );

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");

    const errorMsg = screen.getByRole("alert");
    expect(errorMsg.textContent).toBe("Amount cannot exceed daily cash limit");
  });
});
