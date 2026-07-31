import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

export type GraphNode = {
  id: string;
  label?: string;
  source_file?: string;
  source_location?: string;
  community?: number;
  community_name?: string;
  [key: string]: unknown;
};

export type GraphLink = {
  source: string;
  target: string;
  relation?: string;
  context?: string;
  confidence?: string;
  [key: string]: unknown;
};

export type GraphData = {
  directed?: boolean;
  nodes: GraphNode[];
  links?: GraphLink[];
  edges?: GraphLink[];
};

export type RetrievalDocument = {
  project: string;
  nodeId: string;
  graphSha: string;
  contentHash: string;
  label: string;
  sourceFile: string;
  sourceLocation: string;
  community: number | null;
  communityName: string;
  searchText: string;
  metadata: Record<string, unknown>;
};

export type RankedNode = {
  nodeId: string;
  label: string;
  sourceFile: string;
  sourceLocation: string;
  searchText: string;
  lexicalRank?: number;
  vectorRank?: number;
  ftsRank?: number;
  fusedScore: number;
  rerankScore?: number;
};

export type HybridQueryResult = {
  question: string;
  seeds: RankedNode[];
  nodes: GraphNode[];
  links: GraphLink[];
  retrieval: {
    lexicalCandidates: number;
    vectorCandidates: number;
    ftsCandidates: number;
    rerankedCandidates: number;
    elapsedMs: number;
  };
  synthesis?: GraphifySynthesis;
};

export type GraphifySynthesis = {
  answer: string;
  evidence: Array<{
    nodeId: string;
    label: string;
    sourceFile: string;
    sourceLocation: string;
    reason: string;
  }>;
  limitations: string[];
};

type DatabaseCredentials = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
};

type ApiConfig = {
  endpoint: string;
  apiKey: string;
  embeddingModel: string;
  rerankerModel: string;
  synthesisModel: string;
};

const DEFAULT_PROJECT = "toss-portfolio-lens";
const DEFAULT_GRAPH = "graphify-out/graph.json";
const EMBEDDING_DIMENSIONS = 2560;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function apiConfigFromEnv(): ApiConfig {
  return {
    endpoint: requiredEnv("OPENAI_API_ENDPOINT").replace(/\/+$/, ""),
    apiKey: requiredEnv("OPENAI_API_KEY"),
    embeddingModel: process.env.GRAPHIFY_EMBEDDING_MODEL?.trim() || "qwen3-embedding-4b",
    rerankerModel: process.env.GRAPHIFY_RERANKER_MODEL?.trim() || "qwen3-reranker-4b",
    synthesisModel:
      process.env.GRAPHIFY_SYNTHESIS_MODEL?.trim()
      || "gpt-5.3-codex-spark",
  };
}

function kubernetesSecretCredentials(): Pick<DatabaseCredentials, "user" | "password"> {
  const namespace = process.env.GRAPHIFY_PG_NAMESPACE?.trim() || "pg";
  const secret = process.env.GRAPHIFY_PG_SECRET?.trim() || "graphify-db";
  const raw = execFileSync(
    "kubectl",
    ["-n", namespace, "get", "secret", secret, "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const parsed = JSON.parse(raw) as { data?: { username?: string; password?: string } };
  const username = parsed.data?.username;
  const password = parsed.data?.password;
  if (!username || !password) {
    throw new Error(`Kubernetes Secret ${namespace}/${secret} is missing username or password`);
  }
  return {
    user: Buffer.from(username, "base64").toString("utf8"),
    password: Buffer.from(password, "base64").toString("utf8"),
  };
}

function databaseCredentials(): DatabaseCredentials {
  const url = process.env.GRAPHIFY_DATABASE_URL?.trim();
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      ssl: parsed.searchParams.get("sslmode") === "require",
    };
  }
  const secret = kubernetesSecretCredentials();
  return {
    host: process.env.GRAPHIFY_PG_HOST?.trim() || "172.30.1.36",
    port: Number(process.env.GRAPHIFY_PG_PORT || 5432),
    database: process.env.GRAPHIFY_PG_DATABASE?.trim() || "graphify",
    user: secret.user,
    password: secret.password,
    ssl: process.env.GRAPHIFY_PG_SSL === "require",
  };
}

export function createDatabaseClient(): pg.Client {
  const config = databaseCredentials();
  return new Client({
    ...config,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    application_name: "graphify-hybrid",
    statement_timeout: 60_000,
    query_timeout: 60_000,
  });
}

export async function setupSchema(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS graphify_node_embeddings (
      project text NOT NULL,
      node_id text NOT NULL,
      graph_sha text NOT NULL,
      content_hash text NOT NULL,
      embedding_model text NOT NULL,
      label text NOT NULL,
      source_file text NOT NULL DEFAULT '',
      source_location text NOT NULL DEFAULT '',
      community integer,
      community_name text NOT NULL DEFAULT '',
      search_text text NOT NULL,
      search_tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(search_text, ''))
      ) STORED,
      embedding halfvec(${EMBEDDING_DIMENSIONS}) NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      indexed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project, node_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS graphify_node_embeddings_hnsw
    ON graphify_node_embeddings
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 96)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS graphify_node_embeddings_fts
    ON graphify_node_embeddings USING gin (search_tsv)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS graphify_node_embeddings_source
    ON graphify_node_embeddings (project, source_file)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS graphify_index_runs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project text NOT NULL,
      graph_sha text NOT NULL,
      embedding_model text NOT NULL,
      node_count integer NOT NULL,
      embedded_count integer NOT NULL,
      reused_count integer NOT NULL,
      removed_count integer NOT NULL,
      duration_ms bigint NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function loadGraph(graphPath = DEFAULT_GRAPH): Promise<GraphData> {
  const parsed = JSON.parse(await readFile(graphPath, "utf8")) as GraphData;
  if (!Array.isArray(parsed.nodes)) {
    throw new Error(`Invalid Graphify graph: ${graphPath}`);
  }
  return parsed;
}

function safeSourcePath(root: string, sourceFile: string): string | null {
  if (!sourceFile || sourceFile.includes("\0")) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, sourceFile);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  if (resolved.includes(`${path.sep}graphify-out${path.sep}`)) return null;
  return resolved;
}

function sourceLine(sourceLocation: string): number {
  const match = sourceLocation.match(/L(\d+)/i);
  return match ? Math.max(1, Number(match[1])) : 1;
}

async function sourceSnippet(root: string, node: GraphNode): Promise<string> {
  const sourceFile = String(node.source_file || "");
  const resolved = safeSourcePath(root, sourceFile);
  if (!resolved) return "";
  try {
    const content = await readFile(resolved, "utf8");
    if (content.length > 2_000_000 || content.includes("\0")) return "";
    const lines = content.split(/\r?\n/);
    const line = sourceLine(String(node.source_location || ""));
    const start = Math.max(0, line - 3);
    const end = Math.min(lines.length, line + 8);
    return lines.slice(start, end).join("\n").slice(0, 4_000);
  } catch {
    return "";
  }
}

function relationSummaries(graph: GraphData): Map<string, string[]> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const summaries = new Map<string, string[]>();
  const add = (id: string, value: string) => {
    const current = summaries.get(id) || [];
    if (current.length < 16 && !current.includes(value)) current.push(value);
    summaries.set(id, current);
  };
  for (const link of graph.links || graph.edges || []) {
    const source = byId.get(String(link.source));
    const target = byId.get(String(link.target));
    if (!source || !target) continue;
    const relation = String(link.relation || "related_to");
    add(source.id, `outgoing ${relation} ${(target.label || target.id)}`);
    add(target.id, `incoming ${relation} ${(source.label || source.id)}`);
  }
  return summaries;
}

export async function buildRetrievalDocuments(input: {
  graph: GraphData;
  root?: string;
  project?: string;
  graphSha: string;
  embeddingModel: string;
}): Promise<RetrievalDocument[]> {
  const root = input.root || ".";
  const project = input.project || DEFAULT_PROJECT;
  const relations = relationSummaries(input.graph);
  const documents: RetrievalDocument[] = [];
  const concurrency = 32;
  for (let offset = 0; offset < input.graph.nodes.length; offset += concurrency) {
    const chunk = input.graph.nodes.slice(offset, offset + concurrency);
    const snippets = await Promise.all(chunk.map((node) => sourceSnippet(root, node)));
    for (let index = 0; index < chunk.length; index += 1) {
      const node = chunk[index];
      const label = String(node.label || node.id);
      const sourceFile = String(node.source_file || "");
      const sourceLocation = String(node.source_location || "");
      const communityName = String(node.community_name || "");
      const searchText = [
        `symbol: ${label}`,
        `node_id: ${node.id}`,
        sourceFile ? `source: ${sourceFile}:${sourceLocation}` : "",
        communityName ? `community: ${communityName}` : "",
        ...(relations.get(node.id) || []),
        snippets[index] ? `source snippet:\n${snippets[index]}` : "",
      ].filter(Boolean).join("\n").replaceAll("\0", "").slice(0, 12_000);
      const contentHash = createHash("sha256")
        .update(`${input.embeddingModel}\0${searchText}`)
        .digest("hex");
      documents.push({
        project,
        nodeId: node.id,
        graphSha: input.graphSha,
        contentHash,
        label,
        sourceFile,
        sourceLocation,
        community: typeof node.community === "number" ? node.community : null,
        communityName,
        searchText,
        metadata: {
          fileType: node.file_type || null,
          origin: node._origin || null,
        },
      });
    }
  }
  return documents;
}

async function apiRequest<T>(
  pathName: string,
  body: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<T> {
  const config = apiConfigFromEnv();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${config.endpoint}${pathName}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${pathName} returned HTTP ${response.status} with non-JSON body`);
      }
      if (response.ok) return parsed as T;
      const message = (parsed as { error?: { message?: string } }).error?.message || text.slice(0, 500);
      lastError = new Error(`${pathName} returned HTTP ${response.status}: ${message}`);
      if (response.status < 429 || response.status >= 600 || attempt === 3) throw lastError;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 3) throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError || new Error(`${pathName} failed`);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const config = apiConfigFromEnv();
  const result = await apiRequest<{
    data: Array<{ index: number; embedding: number[] }>;
  }>("/embeddings", {
    model: config.embeddingModel,
    input: texts,
  });
  const vectors = [...result.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error(`Embedding response shape mismatch: expected ${texts.length}x${EMBEDDING_DIMENSIONS}`);
  }
  return vectors;
}

export async function runContinuousBatchWorkers<T>(
  items: T[],
  batchSize: number,
  concurrency: number,
  worker: (batch: T[]) => Promise<void>,
): Promise<void> {
  let nextOffset = 0;
  const workerCount = Math.min(concurrency, Math.ceil(items.length / batchSize));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextOffset < items.length) {
        const offset = nextOffset;
        nextOffset += batchSize;
        await worker(items.slice(offset, offset + batchSize));
      }
    }),
  );
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export function assertSafeProjectReplacement(
  existingNodeIds: string[],
  documentNodeIds: string[],
  allowReplacement = false,
): void {
  if (allowReplacement || existingNodeIds.length < 100 || documentNodeIds.length < 100) return;
  const documents = new Set(documentNodeIds);
  const overlap = existingNodeIds.filter((nodeId) => documents.has(nodeId)).length;
  const denominator = Math.min(existingNodeIds.length, documentNodeIds.length);
  const overlapRatio = denominator > 0 ? overlap / denominator : 1;
  if (overlapRatio < 0.25) {
    throw new Error(
      `Refusing to replace project index: only ${overlap}/${denominator} node IDs overlap. ` +
      "Verify --project, or set GRAPHIFY_ALLOW_PROJECT_REPLACEMENT=1 for an intentional full replacement.",
    );
  }
}

export async function indexGraph(input: {
  graphPath?: string;
  root?: string;
  project?: string;
  graphSha: string;
  batchSize?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number, reused: number) => void;
}): Promise<{
  nodeCount: number;
  embeddedCount: number;
  reusedCount: number;
  removedCount: number;
  durationMs: number;
}> {
  const started = performance.now();
  const config = apiConfigFromEnv();
  const graph = await loadGraph(input.graphPath);
  const project = input.project || DEFAULT_PROJECT;
  const documents = await buildRetrievalDocuments({
    graph,
    root: input.root,
    project,
    graphSha: input.graphSha,
    embeddingModel: config.embeddingModel,
  });
  const client = createDatabaseClient();
  await client.connect();
  try {
    await setupSchema(client);
    const existing = await client.query<{ node_id: string; content_hash: string; embedding_model: string }>(
      `SELECT node_id, content_hash, embedding_model
       FROM graphify_node_embeddings WHERE project = $1`,
      [project],
    );
    assertSafeProjectReplacement(
      existing.rows.map((row) => row.node_id),
      documents.map((document) => document.nodeId),
      process.env.GRAPHIFY_ALLOW_PROJECT_REPLACEMENT === "1",
    );
    const hashes = new Map(existing.rows.map((row) => [row.node_id, `${row.embedding_model}:${row.content_hash}`]));
    const pending = documents.filter(
      (document) => hashes.get(document.nodeId) !== `${config.embeddingModel}:${document.contentHash}`,
    );
    const reusedCount = documents.length - pending.length;
    const batchSize = Math.max(1, Math.min(64, input.batchSize || 64));
    const concurrency = Math.max(1, Math.min(8, input.concurrency || 4));
    let embeddedCount = 0;
    await runContinuousBatchWorkers(pending, batchSize, concurrency, async (batch) => {
      const vectors = await embedTexts(batch.map((document) => document.searchText));
      const values: unknown[] = [];
      const rows = batch.map((document, index) => {
        const base = values.length;
        values.push(
          document.project,
          document.nodeId,
          document.graphSha,
          document.contentHash,
          config.embeddingModel,
          document.label,
          document.sourceFile,
          document.sourceLocation,
          document.community,
          document.communityName,
          document.searchText,
          vectorLiteral(vectors[index]),
          JSON.stringify(document.metadata),
        );
        const p = (n: number) => `$${base + n}`;
        return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)}::halfvec,${p(13)}::jsonb)`;
      });
      await client.query(
        `INSERT INTO graphify_node_embeddings (
          project,node_id,graph_sha,content_hash,embedding_model,label,source_file,
          source_location,community,community_name,search_text,embedding,metadata
        ) VALUES ${rows.join(",")}
        ON CONFLICT (project,node_id) DO UPDATE SET
          graph_sha=EXCLUDED.graph_sha,
          content_hash=EXCLUDED.content_hash,
          embedding_model=EXCLUDED.embedding_model,
          label=EXCLUDED.label,
          source_file=EXCLUDED.source_file,
          source_location=EXCLUDED.source_location,
          community=EXCLUDED.community,
          community_name=EXCLUDED.community_name,
          search_text=EXCLUDED.search_text,
          embedding=EXCLUDED.embedding,
          metadata=EXCLUDED.metadata,
          indexed_at=now()`,
        values,
      );
      embeddedCount += batch.length;
      input.onProgress?.(embeddedCount, pending.length, reusedCount);
    });
    const nodeIds = documents.map((document) => document.nodeId);
    const removed = await client.query(
      `DELETE FROM graphify_node_embeddings
       WHERE project = $1 AND NOT (node_id = ANY($2::text[]))`,
      [project, nodeIds],
    );
    const removedCount = removed.rowCount || 0;
    const durationMs = Math.round(performance.now() - started);
    await client.query(
      `INSERT INTO graphify_index_runs (
        project,graph_sha,embedding_model,node_count,embedded_count,reused_count,removed_count,duration_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [project, input.graphSha, config.embeddingModel, documents.length, embeddedCount, reusedCount, removedCount, durationMs],
    );
    return { nodeCount: documents.length, embeddedCount, reusedCount, removedCount, durationMs };
  } finally {
    await client.end();
  }
}

function queryTokens(question: string): string[] {
  return [...new Set(
    question.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((token) => token.length >= 2) || [],
  )];
}

export function lexicalRank(graph: GraphData, question: string, limit = 50): Array<{ nodeId: string; score: number }> {
  const terms = queryTokens(question);
  const ranked: Array<{ nodeId: string; score: number }> = [];
  for (const node of graph.nodes) {
    const label = String(node.label || "").toLocaleLowerCase();
    const bare = label.replace(/\(\)$/, "");
    const source = String(node.source_file || "").toLocaleLowerCase();
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      if (term === label || term === bare) {
        score += 1_000;
        matched += 1;
      } else if (label.startsWith(term) || bare.startsWith(term)) {
        score += 100;
        matched += 1;
      } else if (label.includes(term)) {
        score += 4;
        matched += 1;
      }
      if (source.includes(term)) score += 1;
    }
    if (matched > 0) score *= (matched / Math.max(1, terms.length)) ** 2;
    if (score > 0) ranked.push({ nodeId: node.id, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  return ranked.slice(0, limit);
}

export function reciprocalRankFusion(
  rankings: Array<{ name: "lexical" | "vector" | "fts"; ids: string[]; weight?: number }>,
  k = 60,
): Map<string, { score: number; lexicalRank?: number; vectorRank?: number; ftsRank?: number }> {
  const fused = new Map<string, { score: number; lexicalRank?: number; vectorRank?: number; ftsRank?: number }>();
  for (const ranking of rankings) {
    ranking.ids.forEach((id, index) => {
      const current = fused.get(id) || { score: 0 };
      const rank = index + 1;
      current.score += (ranking.weight || 1) / (k + rank);
      if (ranking.name === "lexical") current.lexicalRank = rank;
      if (ranking.name === "vector") current.vectorRank = rank;
      if (ranking.name === "fts") current.ftsRank = rank;
      fused.set(id, current);
    });
  }
  return fused;
}

async function databaseRankings(
  client: pg.Client,
  project: string,
  question: string,
  limit: number,
): Promise<{
  vector: Array<RankedNode & { similarity: number }>;
  fts: Array<RankedNode & { similarity: number }>;
}> {
  const [queryVector] = await embedTexts([question]);
  const commonSelect = `
    node_id AS "nodeId", label, source_file AS "sourceFile",
    source_location AS "sourceLocation", search_text AS "searchText"
  `;
  const vector = await client.query<RankedNode & { similarity: number }>(
    `SELECT ${commonSelect}, 1 - (embedding <=> $2::halfvec) AS similarity
     FROM graphify_node_embeddings
     WHERE project = $1
     ORDER BY embedding <=> $2::halfvec
     LIMIT $3`,
    [project, vectorLiteral(queryVector), limit],
  );
  const fts = await client.query<RankedNode & { similarity: number }>(
    `SELECT ${commonSelect},
       ts_rank_cd(search_tsv, plainto_tsquery('simple', $2)) AS similarity
     FROM graphify_node_embeddings
     WHERE project = $1 AND search_tsv @@ plainto_tsquery('simple', $2)
     ORDER BY similarity DESC, node_id
     LIMIT $3`,
    [project, question, limit],
  );
  return { vector: vector.rows, fts: fts.rows };
}

export async function rerank(question: string, candidates: RankedNode[], topN: number): Promise<RankedNode[]> {
  if (candidates.length === 0) return [];
  const config = apiConfigFromEnv();
  const result = await apiRequest<{
    results?: Array<{ index: number; relevance_score?: number; score?: number }>;
    data?: Array<{ index: number; relevance_score?: number; score?: number }>;
  }>("/rerank", {
    model: config.rerankerModel,
    query: question,
    documents: candidates.map((candidate) => candidate.searchText.slice(0, 2_000)),
    top_n: Math.min(topN, candidates.length),
  });
  const rows = result.results || result.data || [];
  return rows.map((row) => ({
    ...candidates[row.index],
    rerankScore: row.relevance_score ?? row.score ?? 0,
  }));
}

function edgeContext(link: GraphLink): string {
  return String(link.context || link.relation || "").toLocaleLowerCase();
}

export function expandSubgraph(
  graph: GraphData,
  seedIds: string[],
  depth = 2,
  contextFilters: string[] = [],
  maxNodes = 100,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const filters = new Set(contextFilters.map((filter) => filter.toLocaleLowerCase()));
  const links = (graph.links || graph.edges || []).filter((link) => {
    if (filters.size === 0) return true;
    const context = edgeContext(link);
    return [...filters].some((filter) => context.includes(filter));
  });
  const adjacency = new Map<string, GraphLink[]>();
  for (const link of links) {
    for (const id of [String(link.source), String(link.target)]) {
      const current = adjacency.get(id) || [];
      current.push(link);
      adjacency.set(id, current);
    }
  }
  const visited = new Set(seedIds.filter((id) => byId.has(id)));
  let frontier = [...visited];
  const includedLinks: GraphLink[] = [];
  for (let level = 0; level < depth && frontier.length > 0 && visited.size < maxNodes; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const link of adjacency.get(id) || []) {
        const neighbor = String(link.source) === id ? String(link.target) : String(link.source);
        if (!byId.has(neighbor)) continue;
        if (!includedLinks.includes(link)) includedLinks.push(link);
        if (!visited.has(neighbor) && visited.size < maxNodes) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: [...visited].map((id) => byId.get(id)!).filter(Boolean),
    links: includedLinks.filter(
      (link) => visited.has(String(link.source)) && visited.has(String(link.target)),
    ),
  };
}

export async function hybridRetrieve(input: {
  question: string;
  graphPath?: string;
  project?: string;
  topK?: number;
  seedCount?: number;
  depth?: number;
  contextFilters?: string[];
  useReranker?: boolean;
}): Promise<Omit<HybridQueryResult, "synthesis">> {
  const started = performance.now();
  const graph = await loadGraph(input.graphPath);
  const project = input.project || DEFAULT_PROJECT;
  const topK = Math.max(10, Math.min(100, input.topK || 50));
  const lexical = lexicalRank(graph, input.question, topK);
  const client = createDatabaseClient();
  await client.connect();
  try {
    const db = await databaseRankings(client, project, input.question, topK);
    const fused = reciprocalRankFusion([
      { name: "lexical", ids: lexical.map((row) => row.nodeId), weight: 1.15 },
      { name: "vector", ids: db.vector.map((row) => row.nodeId), weight: 1 },
      { name: "fts", ids: db.fts.map((row) => row.nodeId), weight: 0.7 },
    ]);
    const candidatesById = new Map<string, RankedNode>();
    for (const row of [...db.vector, ...db.fts]) candidatesById.set(row.nodeId, row);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    let candidates: RankedNode[] = [...fused.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, Math.min(40, topK))
      .map(([nodeId, scores]) => {
        const databaseRow = candidatesById.get(nodeId);
        const graphNode = nodeById.get(nodeId);
        return {
          nodeId,
          label: databaseRow?.label || String(graphNode?.label || nodeId),
          sourceFile: databaseRow?.sourceFile || String(graphNode?.source_file || ""),
          sourceLocation: databaseRow?.sourceLocation || String(graphNode?.source_location || ""),
          searchText: databaseRow?.searchText || [
            graphNode?.label,
            graphNode?.source_file,
            graphNode?.source_location,
          ].filter(Boolean).join("\n"),
          lexicalRank: scores.lexicalRank,
          vectorRank: scores.vectorRank,
          ftsRank: scores.ftsRank,
          fusedScore: scores.score,
        };
      });
    if (input.useReranker !== false) {
      candidates = await rerank(input.question, candidates, candidates.length);
    }
    const seeds = candidates.slice(0, Math.max(1, Math.min(10, input.seedCount || 5)));
    const subgraph = expandSubgraph(
      graph,
      seeds.map((seed) => seed.nodeId),
      input.depth ?? 2,
      input.contextFilters || [],
    );
    return {
      question: input.question,
      seeds,
      ...subgraph,
      retrieval: {
        lexicalCandidates: lexical.length,
        vectorCandidates: db.vector.length,
        ftsCandidates: db.fts.length,
        rerankedCandidates: input.useReranker === false ? 0 : candidates.length,
        elapsedMs: Math.round(performance.now() - started),
      },
    };
  } finally {
    await client.end();
  }
}

function synthesisSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["answer", "evidence", "limitations"],
    properties: {
      answer: { type: "string" },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["nodeId", "label", "sourceFile", "sourceLocation", "reason"],
          properties: {
            nodeId: { type: "string" },
            label: { type: "string" },
            sourceFile: { type: "string" },
            sourceLocation: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
      limitations: { type: "array", items: { type: "string" } },
    },
  };
}

export async function synthesizeWithModel(
  result: Omit<HybridQueryResult, "synthesis">,
): Promise<GraphifySynthesis> {
  const config = apiConfigFromEnv();
  const evidence = {
    seeds: result.seeds.map(({ searchText: _searchText, ...seed }) => seed),
    nodes: result.nodes.slice(0, 80).map((node) => ({
      id: node.id,
      label: node.label,
      source_file: node.source_file,
      source_location: node.source_location,
      community_name: node.community_name,
    })),
    links: result.links.slice(0, 160).map((link) => ({
      source: link.source,
      target: link.target,
      relation: link.relation,
      confidence: link.confidence,
    })),
  };
  const messages = [
    {
      role: "system",
      content: [
        "You answer codebase questions from a bounded Graphify subgraph.",
        "Use only the supplied nodes and links. Never invent an edge.",
        "Answer in Korean unless the user asks otherwise.",
        "Cite concrete source_file and source_location values in the answer.",
        "If evidence is insufficient, state that in limitations.",
      ].join(" "),
    },
    {
      role: "user",
      content: `Question:\n${result.question}\n\nGraph evidence:\n${JSON.stringify(evidence)}`,
    },
  ];
  const body: Record<string, unknown> = {
    model: config.synthesisModel,
    messages,
    max_completion_tokens: 4_000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "graphify_hybrid_answer",
        strict: true,
        schema: synthesisSchema(),
      },
    },
  };
  try {
    const response = await apiRequest<{
      choices: Array<{ message: { content: string } }>;
    }>("/chat/completions", body);
    return JSON.parse(response.choices[0].message.content) as GraphifySynthesis;
  } catch (error) {
    const fallback = await apiRequest<{
      choices: Array<{ message: { content: string } }>;
    }>("/chat/completions", {
      model: config.synthesisModel,
      messages: [
        ...messages,
        { role: "system", content: "Return only valid JSON matching the requested answer/evidence/limitations shape." },
      ],
      max_completion_tokens: 4_000,
    });
    try {
      return JSON.parse(fallback.choices[0].message.content) as GraphifySynthesis;
    } catch {
      throw new Error(
        `Synthesis model ${config.synthesisModel} did not return valid structured JSON: ${String(error)}`,
      );
    }
  }
}

export async function indexStatus(project = DEFAULT_PROJECT): Promise<Record<string, unknown>> {
  const client = createDatabaseClient();
  await client.connect();
  try {
    const result = await client.query(
      `SELECT project, graph_sha, embedding_model, node_count, embedded_count,
              reused_count, removed_count, duration_ms, completed_at
       FROM graphify_index_runs
       WHERE project = $1
       ORDER BY completed_at DESC LIMIT 1`,
      [project],
    );
    const count = await client.query(
      `SELECT count(*)::int AS count, min(indexed_at) AS oldest, max(indexed_at) AS newest
       FROM graphify_node_embeddings WHERE project = $1`,
      [project],
    );
    return { latestRun: result.rows[0] || null, index: count.rows[0] };
  } finally {
    await client.end();
  }
}
