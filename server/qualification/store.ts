import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  QualificationEventSchema,
  QualificationStateSchema,
  type QualificationEvent,
  type QualificationState,
} from "./contracts.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAXIMUM_STATE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_EVENTS_BYTES = 8 * 1024 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;

export type QualificationEventCursor = Readonly<{
  runId: string;
  device: number;
  inode: number;
  offset: number;
}>;

type BoundedRegularRead = {
  payload: Buffer;
  device: number;
  inode: number;
  startOffset: number;
};

export class QualificationRunNotFoundError extends Error {
  constructor() {
    super("Qualification run was not found.");
    this.name = "QualificationRunNotFoundError";
  }
}

function safeRunId(value: string): string {
  if (!RUN_ID.test(value)) throw new QualificationRunNotFoundError();
  return value;
}

function safeArtifactPath(value: string): string {
  if (
    !value
    || value.length > 240
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new QualificationRunNotFoundError();
  }
  return value;
}

function invalidEvidenceFile(): Error {
  return new Error("Qualification evidence file is invalid.");
}

async function readBoundedRegularRange(
  filePath: string,
  maximumBytes: number,
  invalidFile: () => Error = invalidEvidenceFile,
  cursor?: Pick<QualificationEventCursor, "device" | "inode" | "offset">,
): Promise<BoundedRegularRead> {
  let pathStats;
  try {
    pathStats = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new QualificationRunNotFoundError();
    }
    throw error;
  }
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > maximumBytes) {
    throw invalidFile();
  }

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new QualificationRunNotFoundError();
    if (code === "ELOOP") throw invalidFile();
    throw error;
  }
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile()
      || openedStats.size > maximumBytes
      || openedStats.dev !== pathStats.dev
      || openedStats.ino !== pathStats.ino
    ) {
      throw invalidFile();
    }

    // Read exactly the size observed on the opened descriptor. An events file
    // may be appended while an SSE poll is in progress; a path-level readFile
    // could otherwise continue past the validated limit and amplify memory.
    const expectedBytes = openedStats.size;
    const canResume = cursor !== undefined
      && cursor.device === openedStats.dev
      && cursor.inode === openedStats.ino
      && Number.isSafeInteger(cursor.offset)
      && cursor.offset >= 0
      && cursor.offset <= expectedBytes;
    const startOffset = canResume ? cursor.offset : 0;
    const buffer = Buffer.allocUnsafe(expectedBytes - startOffset);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        startOffset + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      payload: buffer.subarray(0, offset),
      device: openedStats.dev,
      inode: openedStats.ino,
      startOffset,
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularBuffer(
  filePath: string,
  maximumBytes: number,
  invalidFile: () => Error = invalidEvidenceFile,
): Promise<Buffer> {
  return (await readBoundedRegularRange(filePath, maximumBytes, invalidFile)).payload;
}

async function readBoundedRegularFile(filePath: string, maximumBytes: number): Promise<string> {
  return (await readBoundedRegularBuffer(filePath, maximumBytes)).toString("utf8");
}

export class QualificationRunStore {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!path.isAbsolute(rootDirectory)) {
      throw new Error("AI qualification run root must be an absolute path.");
    }
    this.rootDirectory = path.resolve(rootDirectory);
  }

  async latestRunId(): Promise<string> {
    const raw = await readBoundedRegularFile(
      path.join(this.rootDirectory, "latest.json"),
      4 * 1024,
    );
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Qualification latest pointer is invalid.");
    }
    const runId = typeof value === "object" && value !== null && "runId" in value
      ? String(value.runId)
      : "";
    return safeRunId(runId);
  }

  async state(runId: string): Promise<QualificationState> {
    const { normalizedRunId, directory } = await this.runDirectory(runId);
    const raw = await readBoundedRegularFile(
      path.join(directory, "state.json"),
      MAXIMUM_STATE_BYTES,
    );
    const state = QualificationStateSchema.parse(JSON.parse(raw));
    if (state.runId !== normalizedRunId) {
      throw new Error("Qualification state belongs to a different run.");
    }
    return state;
  }

  async eventBatch(
    runId: string,
    afterSequence = 0,
    cursor?: QualificationEventCursor,
  ): Promise<{
    events: QualificationEvent[];
    cursor: QualificationEventCursor | undefined;
  }> {
    const { normalizedRunId, directory } = await this.runDirectory(runId);
    let read: BoundedRegularRead;
    try {
      read = await readBoundedRegularRange(
        path.join(directory, "events.jsonl"),
        MAXIMUM_EVENTS_BYTES,
        invalidEvidenceFile,
        cursor?.runId === normalizedRunId ? cursor : undefined,
      );
    } catch (error) {
      if (error instanceof QualificationRunNotFoundError && afterSequence === 0) {
        return { events: [], cursor: undefined };
      }
      throw error;
    }
    const events: QualificationEvent[] = [];
    let start = 0;
    let completedOffset = read.startOffset;
    for (
      let end = read.payload.indexOf(0x0a, start);
      end >= 0;
      end = read.payload.indexOf(0x0a, start)
    ) {
      const line = read.payload.subarray(start, end).toString("utf8");
      start = end + 1;
      completedOffset = read.startOffset + start;
      if (!line.trim()) continue;
      const event = QualificationEventSchema.parse(JSON.parse(line));
      if (event.runId !== normalizedRunId) {
        throw new Error("Qualification event belongs to a different run.");
      }
      if (event.sequence > afterSequence) events.push(event);
    }
    return {
      events: events.sort((left, right) => left.sequence - right.sequence),
      cursor: {
        runId: normalizedRunId,
        device: read.device,
        inode: read.inode,
        offset: completedOffset,
      },
    };
  }

  async events(runId: string, afterSequence = 0): Promise<QualificationEvent[]> {
    return (await this.eventBatch(runId, afterSequence)).events;
  }

  async artifact(
    runId: string,
    relativePath: string,
  ): Promise<{ payload: Buffer; path: string }> {
    const { directory } = await this.runDirectory(runId);
    const normalized = safeArtifactPath(relativePath);
    const artifactPath = path.join(directory, normalized);
    if (path.relative(directory, artifactPath).startsWith("..")) {
      throw new QualificationRunNotFoundError();
    }
    const payload = await readBoundedRegularBuffer(
      artifactPath,
      MAXIMUM_ARTIFACT_BYTES,
      () => new QualificationRunNotFoundError(),
    );
    if (payload.length < 1) throw new QualificationRunNotFoundError();
    return {
      payload,
      path: normalized,
    };
  }

  private async runDirectory(
    runId: string,
  ): Promise<{ normalizedRunId: string; directory: string }> {
    const normalizedRunId = safeRunId(runId);
    const directory = path.join(this.rootDirectory, normalizedRunId);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new QualificationRunNotFoundError();
      }
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new QualificationRunNotFoundError();
    }
    return { normalizedRunId, directory };
  }

  async latest(): Promise<{ state: QualificationState; events: QualificationEvent[] }> {
    const runId = await this.latestRunId();
    const [state, events] = await Promise.all([
      this.state(runId),
      this.events(runId),
    ]);
    return { state, events };
  }
}
