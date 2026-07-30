import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { LoaderCircle } from "lucide-react";
import { LoginPage } from "@/components/login-page";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
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

export default function App() {
  const reportRoute = window.location.pathname.match(/^\/reports(?:\/([^/]+))?\/?$/);
  const reportId = reportRoute?.[1];
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
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
  const markAuthenticated = useCallback(() => setAuthenticated(true), []);
  const markUnauthenticated = useCallback(() => setAuthenticated(false), []);

  useEffect(() => {
    if (reportRoute) return;
    let active = true;
    fetch("/api/auth/session", { headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((payload: { authenticated?: boolean }) => {
        if (active) setAuthenticated(Boolean(payload.authenticated));
      })
      .catch(() => {
        if (active) setAuthenticated(false);
      });
    return () => {
      active = false;
    };
  }, [Boolean(reportRoute)]);

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

  if (authenticated === null) {
    return <AppLoading theme={theme} onToggleTheme={toggleTheme} />;
  }

  if (!authenticated) {
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
