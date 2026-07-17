import type { ArtifactDescriptor, ArtifactType } from "../repositories/artifact-repository.js";
import type { ArtifactRepository } from "../repositories/artifact-repository.js";
import { MCP_SCHEMA_VERSION } from "./service-envelope.js";

export class ArtifactService {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly inlineMaxRows: number,
    private readonly inlineMaxBytes: number,
  ) {}

  shouldExternalize(value: unknown, rowCount?: number): boolean {
    const rows = rowCount ?? (Array.isArray(value) ? value.length : 1);
    return rows > this.inlineMaxRows || Buffer.byteLength(JSON.stringify(value)) > this.inlineMaxBytes;
  }

  put(input: {
    runId: string;
    type: ArtifactType;
    content: unknown;
    rowCount?: number;
    dataRevision: string;
  }): Promise<ArtifactDescriptor> {
    return this.repository.put({
      ...input,
      schemaVersion: MCP_SCHEMA_VERSION,
    });
  }

  get(runId: string, type: ArtifactType) {
    return this.repository.get(runId, type);
  }

  list(runId: string) {
    return this.repository.list(runId);
  }
}
