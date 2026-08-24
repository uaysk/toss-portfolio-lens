import { describe, expect, it, vi } from "vitest";
import { createTurnScopedFrameSerializer } from "./sse-frame-cache.js";

describe("createTurnScopedFrameSerializer", () => {
  it("shares work within one turn without retaining encoded frames", async () => {
    const serialize = vi.fn((event: { revision: number }) => `frame:${event.revision}`);
    const frame = createTurnScopedFrameSerializer(serialize);
    const event = { revision: 1 };
    const anotherEvent = { revision: 2 };

    expect(frame(event)).toBe("frame:1");
    expect(frame(event)).toBe("frame:1");
    expect(frame(anotherEvent)).toBe("frame:2");
    expect(frame(anotherEvent)).toBe("frame:2");
    expect(serialize).toHaveBeenCalledTimes(2);

    await Promise.resolve();
    event.revision = 3;
    expect(frame(event)).toBe("frame:3");
    expect(serialize).toHaveBeenCalledTimes(3);
  });
});
