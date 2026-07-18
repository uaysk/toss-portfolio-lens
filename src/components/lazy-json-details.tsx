import { useState } from "react";

export function LazyJsonDetails({ value, className = "" }: { value: unknown; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className={className}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs font-black">원본 수치 결과 보기</summary>
      {open ? (
        <pre className="mt-4 max-h-[420px] overflow-auto whitespace-pre-wrap break-all text-[10px] leading-5 text-muted-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </details>
  );
}
