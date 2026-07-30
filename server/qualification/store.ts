import { lstat, readFile } from "node:fs/promises";
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

async function readBoundedRegularFile(filePath: string, maximumBytes: number): Promise<string> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new QualificationRunNotFoundError();
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) {
    throw new Error("Qualification evidence file is invalid.");
  }
  return readFile(filePath, "utf8");
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

  async events(runId: string, afterSequence = 0): Promise<QualificationEvent[]> {
    const { normalizedRunId, directory } = await this.runDirectory(runId);
    let raw: string;
    try {
      raw = await readBoundedRegularFile(
        path.join(directory, "events.jsonl"),
        MAXIMUM_EVENTS_BYTES,
      );
    } catch (error) {
      if (error instanceof QualificationRunNotFoundError && afterSequence === 0) return [];
      throw error;
    }
    const events: QualificationEvent[] = [];
    const lines = raw.split("\n");
    if (!raw.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = QualificationEventSchema.parse(JSON.parse(line));
      if (event.runId !== normalizedRunId) {
        throw new Error("Qualification event belongs to a different run.");
      }
      if (event.sequence > afterSequence) events.push(event);
    }
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  async artifact(
    runId: string,
    relativePath: string,
  ): Promise<{ payload: Buffer; path: string }> {
    const { directory } = await this.runDirectory(runId);
    const normalized = safeArtifactPath(relativePath);
    const artifactPath = path.join(directory, normalized);
    let stats;
    try {
      stats = await lstat(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new QualificationRunNotFoundError();
      }
      throw error;
    }
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size < 1
      || stats.size > MAXIMUM_ARTIFACT_BYTES
      || path.relative(directory, artifactPath).startsWith("..")
    ) {
      throw new QualificationRunNotFoundError();
    }
    return {
      payload: await readFile(artifactPath),
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
