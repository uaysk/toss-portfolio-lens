import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
} from "react";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import WifiOff from "lucide-react/dist/esm/icons/wifi-off.js";
import { LoginPage } from "@/components/login-page";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  checkAuthSession,
  invalidateAuthenticationSessionMemory,
  reduceAuthenticationState,
} from "@/lib/auth-session";
import { safeLocalStorage } from "@/lib/safe-storage";
import type { Theme } from "@/types";

const Dashboard = lazy(() => import("@/components/dashboard").then((module) => ({
  default: module.Dashboard,
})));
const ReportPage = lazy(() => import("@/components/report-page").then((module) => ({
  default: module.ReportPage,
})));

function AppLoading({
  theme,
  onToggleTheme,
  label = "불러오는 중",
}: {
  theme: Theme;
  onToggleTheme: () => void;
  label?: string;
}) {
  return (
    <main className="relative grid min-h-screen place-items-center bg-[var(--shell)]">
      <div className="absolute right-5 top-5">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
      <div className="flex flex-col items-center gap-5">
        <Logo />
        <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground" role="status">
          <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
          <span>{label}</span>
        </div>
      </div>
    </main>
  );
}

export function SessionUnavailable({
  theme,
  onToggleTheme,
  onRetry,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onRetry: () => void;
}) {
  return (
    <main className="relative grid min-h-screen place-items-center bg-[var(--shell)] px-5">
      <div className="absolute right-5 top-5">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
      <section
        className="w-full max-w-md rounded-[28px] border border-border bg-card p-7 text-center shadow-xl shadow-black/5 sm:p-9"
        aria-labelledby="session-error-title"
        role="alert"
      >
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-secondary">
          <WifiOff className="size-5" aria-hidden="true" />
        </div>
        <h1 id="session-error-title" className="mt-5 text-2xl font-black tracking-[-0.035em]">
          서버에 연결할 수 없습니다
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          로그인 상태를 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mx-auto mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          다시 시도
        </button>
      </section>
    </main>
  );
}

export default function App() {
  const reportRoute = window.location.pathname.match(/^\/reports(?:\/([^/]+))?\/?$/);
  const reportId = reportRoute?.[1];
  const [authentication, dispatchAuthentication] = useReducer(reduceAuthenticationState, "checking");
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [theme, setTheme] = useState<Theme>(() =>
    safeLocalStorage.getItem("portfolio-theme") === "light" ? "light" : "dark",
  );

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#050505" : "#ececea");
    safeLocalStorage.setItem("portfolio-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((value) => value === "dark" ? "light" : "dark");
  }, []);
  const markAuthenticated = useCallback(() => {
    invalidateAuthenticationSessionMemory();
    dispatchAuthentication({ type: "signed-in" });
  }, []);
  const markUnauthenticated = useCallback(() => {
    invalidateAuthenticationSessionMemory();
    dispatchAuthentication({ type: "signed-out" });
  }, []);
  const retrySession = useCallback(() => {
    dispatchAuthentication({ type: "retry" });
    setSessionAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (reportRoute) return;
    const controller = new AbortController();
    void checkAuthSession(controller.signal).then((event) => {
      if (!controller.signal.aborted) dispatchAuthentication(event);
    });
    return () => controller.abort();
  }, [Boolean(reportRoute), sessionAttempt]);

  if (reportRoute) {
    return (
      <Suspense
        fallback={(
          <AppLoading
            theme={theme}
            onToggleTheme={toggleTheme}
            label="보고서 화면을 불러오는 중"
          />
        )}
      >
        <ReportPage reportId={reportId} theme={theme} onToggleTheme={toggleTheme} />
      </Suspense>
    );
  }

  if (authentication === "checking") {
    return <AppLoading theme={theme} onToggleTheme={toggleTheme} />;
  }

  if (authentication === "unavailable") {
    return (
      <SessionUnavailable
        theme={theme}
        onToggleTheme={toggleTheme}
        onRetry={retrySession}
      />
    );
  }

  if (authentication === "unauthenticated") {
    return <LoginPage onAuthenticated={markAuthenticated} theme={theme} onToggleTheme={toggleTheme} />;
  }

  return (
    <Suspense
      fallback={(
        <AppLoading
          theme={theme}
          onToggleTheme={toggleTheme}
          label="대시보드 화면을 불러오는 중"
        />
      )}
    >
      <Dashboard
        onLogout={markUnauthenticated}
        onUnauthorized={markUnauthenticated}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    </Suspense>
  );
}
