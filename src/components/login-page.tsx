import { FormEvent, useState } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Theme } from "@/types";

type LoginPageProps = {
  onAuthenticated: () => void;
  theme: Theme;
  onToggleTheme: () => void;
};

export function LoginPage({ onAuthenticated, theme, onToggleTheme }: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        authenticated?: boolean;
        error?: { message?: string };
      };
      if (!response.ok || !payload.authenticated) {
        throw new Error(payload.error?.message || "로그인할 수 없습니다.");
      }
      setPassword("");
      onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로그인할 수 없습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-stage">
      <section className="login-shell" aria-labelledby="login-title">
        <div className="login-panel">
          <div className="flex items-center justify-between gap-4">
            <Logo />
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          </div>

          <div className="mx-auto flex w-full max-w-[410px] flex-1 flex-col justify-center py-12">
            <div className="mb-10">
              <div className="mb-6 grid size-12 place-items-center rounded-2xl bg-secondary">
                <LockKeyhole className="size-5" aria-hidden="true" />
              </div>
              <p className="mb-3 text-sm font-semibold text-muted-foreground">PRIVATE PORTFOLIO</p>
              <h1 id="login-title" className="text-[clamp(2.1rem,4vw,3.35rem)] font-black leading-[1.02] tracking-[-0.055em]">
                내 투자 현황을
                <br />
                한눈에.
              </h1>
              <p className="mt-5 max-w-sm text-[15px] leading-7 text-muted-foreground">
                토스증권 보유 자산을 읽기 전용으로 확인하는 개인 대시보드입니다.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2.5">
                <Label htmlFor="password">대시보드 비밀번호</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="비밀번호를 입력하세요"
                    className="h-14 pr-12"
                    autoFocus
                    aria-describedby={error ? "login-error" : undefined}
                    aria-invalid={Boolean(error)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              {error ? (
                <p id="login-error" role="alert" className="rounded-2xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">
                  {error}
                </p>
              ) : null}

              <Button type="submit" size="lg" className="h-14 w-full justify-between rounded-2xl" disabled={!password || submitting}>
                <span>{submitting ? "확인하는 중" : "포트폴리오 열기"}</span>
                {submitting ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
              </Button>
            </form>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            계정 정보는 브라우저에 저장되지 않으며, 세션은 12시간 후 만료됩니다.
          </p>
        </div>

        <aside className="login-visual" aria-hidden="true">
          <div className="visual-orbit visual-orbit-one" />
          <div className="visual-orbit visual-orbit-two" />
          <div className="relative z-10 flex h-full flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold tracking-wide text-white/80">
                READ ONLY
              </span>
              <span className="size-2 rounded-full bg-white" />
            </div>
            <div>
              <p className="mb-4 text-sm font-medium text-white/50">Focused on what matters.</p>
              <p className="max-w-xl text-[clamp(2.8rem,5vw,5.8rem)] font-black leading-[0.94] tracking-[-0.065em] text-white">
                Clear view.
                <br />
                Quiet mind.
              </p>
              <div className="mt-12 grid grid-cols-3 gap-3">
                {["계좌", "수익", "보유 종목"].map((label, index) => (
                  <div key={label} className="rounded-[22px] bg-white/[0.08] p-4 backdrop-blur-sm">
                    <p className="text-[11px] font-semibold text-white/50">0{index + 1}</p>
                    <p className="mt-8 text-sm font-bold text-white">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
