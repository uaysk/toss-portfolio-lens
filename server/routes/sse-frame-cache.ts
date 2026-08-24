/**
 * Reuses an encoded SSE frame across synchronous listener fan-out, then drops
 * the string before the event can remain in a replay buffer for another turn.
 */
export function createTurnScopedFrameSerializer<T extends object>(
  serialize: (event: T) => string,
): (event: T) => string {
  let frames = new WeakMap<T, string>();
  let resetScheduled = false;
  return (event) => {
    const cached = frames.get(event);
    if (cached !== undefined) return cached;
    const frame = serialize(event);
    frames.set(event, frame);
    if (!resetScheduled) {
      resetScheduled = true;
      queueMicrotask(() => {
        frames = new WeakMap<T, string>();
        resetScheduled = false;
      });
    }
    return frame;
  };
}
