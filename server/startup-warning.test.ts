import { describe, expect, it, vi } from "vitest";
import { warnReadOnlyApiTokenFallbackOnce } from "./startup-warning.js";

describe("startup authentication warnings", () => {
  it("emits one secret-free warning only for the legacy token fallback", () => {
    const warn = vi.fn();
    warnReadOnlyApiTokenFallbackOnce("READ_ONLY_API_TOKEN", warn);
    warnReadOnlyApiTokenFallbackOnce("DASHBOARD_PASSWORD", warn);
    warnReadOnlyApiTokenFallbackOnce("DASHBOARD_PASSWORD", warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("READ_ONLY_API_TOKEN");
    expect(warn.mock.calls[0]?.[0]).toContain("DASHBOARD_PASSWORD");
    expect(warn.mock.calls[0]?.[0]).not.toContain("dashboard-password-long");
  });
});
