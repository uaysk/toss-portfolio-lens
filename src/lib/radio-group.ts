import type { KeyboardEvent } from "react";

const RADIO_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
]);

/**
 * Gives button-backed ARIA radio groups the keyboard behavior native radio
 * inputs provide: arrows move and select, while Home/End jump to the edges.
 */
export function handleRadioGroupKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
): void {
  if (!RADIO_NAVIGATION_KEYS.has(event.key)) return;
  const group = event.currentTarget.closest<HTMLElement>('[role="radiogroup"]');
  if (!group) return;
  const radios = Array.from(group.querySelectorAll<HTMLButtonElement>(
    'button[role="radio"]:not(:disabled):not([aria-disabled="true"])',
  ));
  const currentIndex = radios.indexOf(event.currentTarget);
  if (currentIndex < 0 || radios.length === 0) return;

  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? radios.length - 1
      : (currentIndex + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1)
        + radios.length) % radios.length;
  const next = radios[nextIndex]!;
  next.focus();
  next.click();
}
