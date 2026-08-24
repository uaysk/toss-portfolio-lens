import { describe, expect, it, vi } from "vitest";
import { preferredScrollBehavior } from "./motion-preference";

describe("preferredScrollBehavior", () => {
  it("uses instant scrolling when reduced motion is requested", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));

    expect(preferredScrollBehavior(matchMedia)).toBe("auto");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("keeps smooth scrolling for the default motion preference", () => {
    expect(preferredScrollBehavior(() => ({ matches: false }))).toBe("smooth");
  });
});
