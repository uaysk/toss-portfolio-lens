import { describe, expect, it, vi } from "vitest";
import { handleRadioGroupKeyDown } from "./radio-group.js";

function radioGroupEvent(key: string, currentIndex: number, count = 3) {
  const radios = Array.from({ length: count }, () => ({
    click: vi.fn(),
    focus: vi.fn(),
  }));
  const group = { querySelectorAll: vi.fn(() => radios) };
  const current = Object.assign(radios[currentIndex]!, {
    closest: vi.fn(() => group),
  });
  const preventDefault = vi.fn();
  return {
    event: { key, currentTarget: current, preventDefault } as never,
    radios,
    preventDefault,
  };
}

describe("handleRadioGroupKeyDown", () => {
  it.each([
    ["ArrowRight", 1],
    ["ArrowDown", 1],
    ["ArrowLeft", 2],
    ["ArrowUp", 2],
    ["Home", 0],
    ["End", 2],
  ])("moves and selects on %s", (key, expectedIndex) => {
    const { event, radios, preventDefault } = radioGroupEvent(key, 0);

    handleRadioGroupKeyDown(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(radios[expectedIndex]!.focus).toHaveBeenCalledOnce();
    expect(radios[expectedIndex]!.click).toHaveBeenCalledOnce();
  });

  it("leaves unrelated keys to the button", () => {
    const { event, radios, preventDefault } = radioGroupEvent("Enter", 0);

    handleRadioGroupKeyDown(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(radios.every((radio) => !radio.focus.mock.calls.length)).toBe(true);
    expect(radios.every((radio) => !radio.click.mock.calls.length)).toBe(true);
  });
});
