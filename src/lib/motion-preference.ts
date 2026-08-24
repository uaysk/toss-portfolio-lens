const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type MatchMedia = (query: string) => Pick<MediaQueryList, "matches">;

export function preferredScrollBehavior(
  matchMedia: MatchMedia | undefined = typeof window === "undefined"
    ? undefined
    : typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : undefined,
): ScrollBehavior {
  return matchMedia?.(REDUCED_MOTION_QUERY).matches ? "auto" : "smooth";
}
