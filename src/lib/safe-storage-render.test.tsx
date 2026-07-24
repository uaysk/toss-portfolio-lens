import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { Dashboard } from "@/components/dashboard";

function blockedStorageWindow() {
  const value = {
    location: {
      pathname: "/",
      hash: "#overview",
    },
  };
  Object.defineProperty(value, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("blocked", "SecurityError");
    },
  });
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("blocked browser storage rendering", () => {
  it("테마 저장소를 읽을 수 없어도 App 기본 화면을 렌더링한다", () => {
    vi.stubGlobal("window", blockedStorageWindow());
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("불러오는 중");
  });

  it("숨김 종목 저장소를 읽을 수 없어도 Dashboard를 렌더링한다", () => {
    vi.stubGlobal("window", blockedStorageWindow());
    const markup = renderToStaticMarkup(
      <Dashboard
        onLogout={() => undefined}
        onUnauthorized={() => undefined}
        theme="dark"
        onToggleTheme={() => undefined}
      />,
    );
    expect(markup).toContain("dashboard-frame");
  });
});
