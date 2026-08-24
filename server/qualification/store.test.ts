import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
  QualificationEventSchema,
  type QualificationEvent,
} from "./contracts.js";
import { QualificationRunStore } from "./store.js";

const directories: string[] = [];

function event(runId: string, sequence: number, message = `event-${sequence}`): QualificationEvent {
  return {
    schemaVersion: AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
    sequence,
    runId,
    at: `2026-07-27T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type: "step_output",
    message,
  };
}

async function fixture(runId: string, events: QualificationEvent[]) {
  const root = await mkdtemp(path.join(tmpdir(), "qualification-store-"));
  directories.push(root);
  const directory = path.join(root, runId);
  const eventPath = path.join(directory, "events.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(
    eventPath,
    events.map((item) => `${JSON.stringify(item)}\n`).join(""),
  );
  return {
    root,
    eventPath,
    store: new QualificationRunStore(root),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("QualificationRunStore event reads", () => {
  it("advances an inode-scoped byte cursor and retries an incomplete final line", async () => {
    const runId = "incremental-events";
    const first = event(runId, 1, "첫 이벤트");
    const second = event(runId, 2, "두 번째 이벤트");
    const firstLine = `${JSON.stringify(first)}\n`;
    const secondLine = JSON.stringify(second);
    const { eventPath, store } = await fixture(runId, [first]);
    const parse = vi.spyOn(QualificationEventSchema, "parse");

    const initial = await store.eventBatch(runId);
    expect(initial.events).toEqual([first]);
    expect(initial.cursor?.offset).toBe(Buffer.byteLength(firstLine));
    expect(parse).toHaveBeenCalledTimes(1);

    const unchanged = await store.eventBatch(runId, 1, initial.cursor);
    expect(unchanged.events).toEqual([]);
    expect(unchanged.cursor).toEqual(initial.cursor);
    expect(parse).toHaveBeenCalledTimes(1);

    await appendFile(eventPath, secondLine);
    const partial = await store.eventBatch(runId, 1, unchanged.cursor);
    expect(partial.events).toEqual([]);
    expect(partial.cursor?.offset).toBe(initial.cursor?.offset);
    expect(parse).toHaveBeenCalledTimes(1);

    await appendFile(eventPath, "\n");
    const completed = await store.eventBatch(runId, 1, partial.cursor);
    expect(completed.events).toEqual([second]);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(completed.cursor?.offset).toBe(
      Buffer.byteLength(firstLine) + Buffer.byteLength(`${secondLine}\n`),
    );
  });

  it("restarts safely when an events file is replaced or truncated", async () => {
    const runId = "replaced-events";
    const original = event(runId, 1);
    const replacement = event(runId, 2, "x".repeat(1_000));
    const afterTruncate = event(runId, 3);
    const { root, eventPath, store } = await fixture(runId, [original]);
    const initial = await store.eventBatch(runId);
    const replacementPath = path.join(root, runId, "events.next.jsonl");
    await writeFile(replacementPath, `${JSON.stringify(replacement)}\n`);
    await rename(replacementPath, eventPath);

    const replaced = await store.eventBatch(runId, 1, initial.cursor);
    expect(replaced.events).toEqual([replacement]);
    expect(replaced.cursor?.inode).not.toBe(initial.cursor?.inode);

    // writeFile truncates the same inode. The shorter size invalidates the old
    // byte offset, so the replacement log is scanned from byte zero.
    await writeFile(eventPath, `${JSON.stringify(afterTruncate)}\n`);
    const truncated = await store.eventBatch(runId, 2, replaced.cursor);
    expect(truncated.events).toEqual([afterTruncate]);
  });

  it("keeps symlink and maximum-size validation on incremental reads", async () => {
    const runId = "bounded-events";
    const { root, eventPath, store } = await fixture(runId, [event(runId, 1)]);
    const initial = await store.eventBatch(runId);
    const outsidePath = path.join(root, "outside-events.jsonl");
    await writeFile(outsidePath, `${JSON.stringify(event(runId, 2))}\n`);
    await rm(eventPath);
    await symlink(outsidePath, eventPath);

    await expect(store.eventBatch(runId, 1, initial.cursor)).rejects.toThrow(
      "Qualification evidence file is invalid.",
    );

    await rm(eventPath);
    await writeFile(eventPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    await expect(store.eventBatch(runId)).rejects.toThrow(
      "Qualification evidence file is invalid.",
    );
  });
});
