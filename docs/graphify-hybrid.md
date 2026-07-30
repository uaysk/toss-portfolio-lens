# Graphify hybrid retrieval

This project augments Graphify's deterministic graph traversal with a persistent hybrid retrieval layer:

1. Graphify lexical symbol/path matching.
2. Qwen3 Embedding 4B vectors stored as `halfvec(2560)` in pgvector.
3. PostgreSQL full-text search.
4. Reciprocal-rank fusion.
5. Qwen3 Reranker 4B over the bounded candidate set.
6. BFS expansion over real Graphify edges.
7. GPT-5.6 Terra structured synthesis with source locations.

Secrets stay in `.env.graphify` and the Kubernetes `pg/graphify-db` Secret. The project MCP configuration contains no credentials.

## Commands

```bash
scripts/graphify-hybrid/run.sh setup
scripts/graphify-hybrid/run.sh index
scripts/graphify-hybrid/run.sh query "한국어 또는 영어 코드 질문"
scripts/graphify-hybrid/run.sh query "호출 관계" --context call
scripts/graphify-hybrid/run.sh status
scripts/graphify-hybrid/run.sh benchmark --out graphify-out/hybrid-benchmark.json
```

The indexer uses a content hash and only re-embeds changed nodes. It removes stale project nodes after a successful index.

## Kubernetes resources

- CNPG cluster: `pg/pg-prod-block`
- Database: `pg/Database/graphify`
- Login Secret: `pg/graphify-db`
- PostgreSQL database/owner: `graphify`
- Extension: `vector`

The role is `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, and owns only the dedicated Graphify database.

## MCP

`.mcp.json` starts both:

- `graphify`: native graph navigation (`query_graph`, node, neighbor, community, path tools)
- `graphify-hybrid`: semantic retrieval and hybrid index status

Both are stdio servers and start on demand in MCP-compatible clients.

