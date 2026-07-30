#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

type NodeRecord = { id: string; _origin?: string; source_file?: string; file_type?: string; [key: string]: unknown };
type LinkRecord = { source: string; target: string; _origin?: string; relation?: string; source_file?: string; [key: string]: unknown };
type HyperedgeRecord = { id: string; nodes?: string[]; [key: string]: unknown };
type GraphRecord = {
  directed?: boolean;
  multigraph?: boolean;
  graph?: Record<string, unknown>;
  nodes: NodeRecord[];
  links?: LinkRecord[];
  edges?: LinkRecord[];
  hyperedges?: HyperedgeRecord[];
};

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readGraph(file: string): Promise<GraphRecord> {
  return JSON.parse(await readFile(file, "utf8")) as GraphRecord;
}

function links(graph: GraphRecord): LinkRecord[] {
  return graph.links || graph.edges || [];
}

function edgeKey(edge: LinkRecord): string {
  return [
    edge.source,
    edge.target,
    edge.relation || "",
    edge.source_file || "",
    edge.source_location || "",
  ].join("\0");
}

const output = argument("output", "graphify-out/graph.json");
const base = await readGraph(argument("base", output));
const semantic = await readGraph(argument("semantic", "/tmp/tpl-graphify-terra-v3/graphify-out/graph.json"));
const database = await readGraph(argument("database", "/tmp/tpl-db-graph/graphify-out/graph.json"));
const cargo = await readGraph(argument("cargo", "/tmp/tpl-rust-graph/graphify-out/graph.json"));

const nodeById = new Map(base.nodes.map((node) => [node.id, node]));
const outputLinks = [...links(base)];
const seenEdges = new Set(outputLinks.map(edgeKey));

let semanticNodesAdded = 0;
for (const node of semantic.nodes.filter((candidate) => candidate._origin !== "ast")) {
  if (!nodeById.has(node.id)) {
    const added = { ...node, _origin: "semantic" };
    nodeById.set(node.id, added);
    semanticNodesAdded += 1;
  }
}

let semanticEdgesAdded = 0;
for (const edge of links(semantic).filter((candidate) => candidate._origin !== "ast")) {
  if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
  const added = { ...edge, _origin: "semantic" };
  const key = edgeKey(added);
  if (!seenEdges.has(key)) {
    seenEdges.add(key);
    outputLinks.push(added);
    semanticEdgesAdded += 1;
  }
}

const dbId = (id: string) => `db:toss_portfolio_lens:${id}`;
let databaseNodesAdded = 0;
for (const node of database.nodes) {
  const id = dbId(node.id);
  if (nodeById.has(id)) continue;
  nodeById.set(id, {
    ...node,
    id,
    label: node.id === "schema" ? "toss_portfolio_lens database" : node.label,
    file_type: "database",
    source_file: "database/toss_portfolio_lens/schema.sql",
    community_name: "PostgreSQL Schema",
    _origin: "database_schema",
  });
  databaseNodesAdded += 1;
}

let databaseEdgesAdded = 0;
for (const edge of links(database)) {
  const added = {
    ...edge,
    source: dbId(edge.source),
    target: dbId(edge.target),
    source_file: "database/toss_portfolio_lens/schema.sql",
    _origin: "database_schema",
  };
  const key = edgeKey(added);
  if (!seenEdges.has(key)) {
    seenEdges.add(key);
    outputLinks.push(added);
    databaseEdgesAdded += 1;
  }
}

const cargoNodes = cargo.nodes.filter((node) => node.id.startsWith("crate:"));
let cargoNodesAdded = 0;
for (const node of cargoNodes) {
  if (!nodeById.has(node.id)) {
    nodeById.set(node.id, {
      ...node,
      source_file: "worker/rust/Cargo.toml",
      community_name: "Rust Workspace",
      _origin: "cargo",
    });
    cargoNodesAdded += 1;
  }
}

const hyperedgeById = new Map<string, HyperedgeRecord>();
for (const hyperedge of [...(base.hyperedges || []), ...(semantic.hyperedges || [])]) {
  if (!hyperedge.id) continue;
  const referenced = hyperedge.nodes || [];
  if (referenced.every((id) => nodeById.has(id))) {
    hyperedgeById.set(hyperedge.id, hyperedge);
  }
}

const result: GraphRecord = {
  ...base,
  directed: true,
  multigraph: false,
  graph: {
    ...(base.graph || {}),
    hybrid_overlay: {
      semantic_source: argument("semantic", "/tmp/tpl-graphify-terra-v3/graphify-out/graph.json"),
      database_source: argument("database", "/tmp/tpl-db-graph/graphify-out/graph.json"),
      cargo_source: argument("cargo", "/tmp/tpl-rust-graph/graphify-out/graph.json"),
    },
  },
  nodes: [...nodeById.values()],
  links: outputLinks,
  hyperedges: [...hyperedgeById.values()],
};
delete result.edges;

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  nodes: result.nodes.length,
  edges: result.links?.length || 0,
  hyperedges: result.hyperedges?.length || 0,
  semanticNodesAdded,
  semanticEdgesAdded,
  databaseNodesAdded,
  databaseEdgesAdded,
  cargoNodesAdded,
  directed: result.directed,
}, null, 2));
