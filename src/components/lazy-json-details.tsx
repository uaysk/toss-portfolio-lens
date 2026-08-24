import { memo, useMemo, useState } from "react";

function LazyJsonDetailsView({ value, className = "" }: { value: unknown; className?: string }) {
  const [open, setOpen] = useState(false);
  const serializedValue = useMemo(
    () => open ? JSON.stringify(value, null, 2) : "",
    [open, value],
  );

  return (
    <details
      className={className}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs font-black">원본 수치 결과 보기</summary>
      {open ? (
        <pre className="mt-4 max-h-[420px] overflow-auto whitespace-pre-wrap break-all text-[10px] leading-5 text-muted-foreground">
          {serializedValue}
        </pre>
      ) : null}
    </details>
  );
}

/**
 * Raw artifacts can be large. Keep a closed inspector out of parent updates and
 * retain its serialized form while unrelated controls rerender a caller that
 * preserves the artifact value's identity.
 */
export const LazyJsonDetails = memo(LazyJsonDetailsView);
