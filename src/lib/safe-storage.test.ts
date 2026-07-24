import { describe, expect, it, vi } from "vitest";
import { createSafeStorage, type StorageAccess } from "./safe-storage";

describe("safe storage", () => {
  it("정상 storage의 값을 읽고 쓰고 삭제한다", () => {
    const values = new Map<string, string>();
    const storage: StorageAccess = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const safeStorage = createSafeStorage(() => storage);

    expect(safeStorage.getItem("theme")).toBeNull();
    expect(safeStorage.setItem("theme", "dark")).toBe(true);
    expect(safeStorage.getItem("theme")).toBe("dark");
    expect(safeStorage.removeItem("theme")).toBe(true);
    expect(safeStorage.getItem("theme")).toBeNull();
  });

  it("storage getter가 SecurityError를 던져도 fallback한다", () => {
    const resolveStorage = vi.fn((): StorageAccess => {
      throw new DOMException("blocked", "SecurityError");
    });
    const safeStorage = createSafeStorage(resolveStorage);

    expect(safeStorage.getItem("theme")).toBeNull();
    expect(safeStorage.setItem("theme", "dark")).toBe(false);
    expect(safeStorage.removeItem("theme")).toBe(false);
  });

  it("storage 메서드가 SecurityError를 던져도 예외를 노출하지 않는다", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const safeStorage = createSafeStorage(() => ({
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    }));

    expect(safeStorage.getItem("portfolio-hidden-stocks")).toBeNull();
    expect(safeStorage.setItem("portfolio-hidden-stocks", "[]")).toBe(false);
    expect(safeStorage.removeItem("portfolio-hidden-stocks")).toBe(false);
  });

  it("브라우저 storage가 없으면 세션 기본값으로 fallback한다", () => {
    const safeStorage = createSafeStorage(() => undefined);
    expect(safeStorage.getItem("theme")).toBeNull();
    expect(safeStorage.setItem("theme", "light")).toBe(false);
  });
});
