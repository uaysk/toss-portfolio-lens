import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  apiConfigFromEnv,
  assertSafeProjectReplacement,
  buildRetrievalDocuments,
  expandSubgraph,
  lexicalRank,
  reciprocalRankFusion,
  runContinuousBatchWorkers,
  type GraphData,
} from "./core.js";

const graph: GraphData = {
  directed: true,
  nodes: [
    { id: "a", label: "RunRepository", source_file: "server/run.ts" },
    { id: "b", label: "RunService", source_file: "server/service.ts" },
    { id: "c", label: "Dashboard", source_file: "src/dashboard.tsx" },
  ],
  links: [
    { source: "b", target: "a", relation: "calls", context: "call" },
    { source: "c", target: "b", relation: "imports", context: "import" },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("graphify hybrid retrieval primitives", () => {
  it("uses Codex Spark as the default synthesis model", () => {
    vi.stubEnv("OPENAI_API_ENDPOINT", "https://example.invalid/v1");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("GRAPHIFY_SYNTHESIS_MODEL", "");

    expect(apiConfigFromEnv().synthesisModel).toBe("gpt-5.3-codex-spark");
  });

  it("uses the generic synthesis override", () => {
    vi.stubEnv("OPENAI_API_ENDPOINT", "https://example.invalid/v1");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("GRAPHIFY_SYNTHESIS_MODEL", "preferred-model");
    expect(apiConfigFromEnv().synthesisModel).toBe("preferred-model");
  });

  it("preserves exact lexical symbol matches", () => {
    expect(lexicalRank(graph, "RunRepository")[0]?.nodeId).toBe("a");
  });

  it("combines independent rankings with reciprocal rank fusion", () => {
    const fused = reciprocalRankFusion([
      { name: "lexical", ids: ["a", "b"] },
      { name: "vector", ids: ["b", "c"] },
    ]);
    expect(fused.get("b")!.score).toBeGreaterThan(fused.get("a")!.score);
    expect(fused.get("b")!.lexicalRank).toBe(2);
    expect(fused.get("b")!.vectorRank).toBe(1);
  });

  it("expands bidirectionally while respecting context filters", () => {
    const calls = expandSubgraph(graph, ["a"], 2, ["call"]);
    expect(calls.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
    expect(calls.links).toHaveLength(1);
    const all = expandSubgraph(graph, ["a"], 2);
    expect(all.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not pass binary NUL bytes from source files into PostgreSQL text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "graphify-hybrid-test-"));
    try {
      await writeFile(path.join(root, "image.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
      const documents = await buildRetrievalDocuments({
        graph: {
          directed: true,
          nodes: [{ id: "image", label: "Image", source_file: "image.png" }],
          links: [],
        },
        root,
        project: "test",
        graphSha: "test-sha",
        embeddingModel: "test-model",
      });
      expect(documents[0].searchText).not.toContain("\0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a low-overlap project replacement unless explicitly allowed", () => {
    const existing = Array.from({ length: 100 }, (_, index) => `old-${index}`);
    const documents = Array.from({ length: 100 }, (_, index) => `new-${index}`);
    expect(() => assertSafeProjectReplacement(existing, documents)).toThrow(
      "Refusing to replace project index",
    );
    expect(() => assertSafeProjectReplacement(existing, documents, true)).not.toThrow();
  });

  it("starts the next embedding batch without waiting for a global wave barrier", async () => {
    const started: number[] = [];
    const release = new Map<number, () => void>();
    const running = runContinuousBatchWorkers([0, 1, 2], 1, 2, async ([item]) => {
      started.push(item);
      await new Promise<void>((resolve) => release.set(item, resolve));
    });
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    release.get(0)!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    release.get(1)!();
    release.get(2)!();
    await running;
  });
});
