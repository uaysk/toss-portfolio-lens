import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/types";

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const nextTheme = theme === "dark" ? "라이트" : "다크";
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      onClick={onToggle}
      aria-label={`${nextTheme} 테마로 전환`}
      title={`${nextTheme} 테마로 전환`}
    >
      {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  );
}
