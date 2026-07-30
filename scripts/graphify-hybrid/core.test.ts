import { describe, expect, it } from "vitest";
import {
  expandSubgraph,
  lexicalRank,
  reciprocalRankFusion,
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

describe("graphify hybrid retrieval primitives", () => {
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
});

