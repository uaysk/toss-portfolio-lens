import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Dashboard } from "@/components/dashboard";
import { LoginPage } from "@/components/login-page";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import type { Theme } from "@/types";

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<Theme>(() =>
    window.localStorage.getItem("portfolio-theme") === "light" ? "light" : "dark",
  );

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#050505" : "#ececea");
    window.localStorage.setItem("portfolio-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((value) => value === "dark" ? "light" : "dark");
  }, []);
  const markAuthenticated = useCallback(() => setAuthenticated(true), []);
  const markUnauthenticated = useCallback(() => setAuthenticated(false), []);

  useEffect(() => {
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
  }, []);

  if (authenticated === null) {
    return (
      <main className="relative grid min-h-screen place-items-center bg-[var(--shell)]">
        <div className="absolute right-5 top-5"><ThemeToggle theme={theme} onToggle={toggleTheme} /></div>
        <div className="flex flex-col items-center gap-5">
          <Logo />
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="불러오는 중" />
        </div>
      </main>
    );
  }

  if (!authenticated) {
    return <LoginPage onAuthenticated={markAuthenticated} theme={theme} onToggleTheme={toggleTheme} />;
  }

  return (
    <Dashboard
      onLogout={markUnauthenticated}
      onUnauthorized={markUnauthenticated}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}
