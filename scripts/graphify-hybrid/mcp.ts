#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { hybridRetrieve, indexStatus, synthesizeWithTerra } from "./core.js";

const server = new McpServer({
  name: "graphify-hybrid",
  version: "1.0.0",
});

server.registerTool(
  "hybrid_query",
  {
    title: "Graphify hybrid query",
    description: "Search Graphify with lexical, Qwen3 embedding, pgvector, Qwen3 reranking, graph traversal, and optional Terra synthesis.",
    inputSchema: {
      question: z.string().min(1),
      depth: z.number().int().min(0).max(4).default(2),
      seedCount: z.number().int().min(1).max(10).default(5),
      contextFilters: z.array(z.string()).default([]),
      synthesize: z.boolean().default(true),
    },
  },
  async ({ question, depth, seedCount, contextFilters, synthesize }) => {
    const retrieval = await hybridRetrieve({
      question,
      depth,
      seedCount,
      contextFilters,
    });
    const result = synthesize
      ? { ...retrieval, synthesis: await synthesizeWithTerra(retrieval) }
      : retrieval;
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "hybrid_index_status",
  {
    title: "Graphify hybrid index status",
    description: "Return the latest pgvector index run and indexed-node counts.",
    inputSchema: {},
  },
  async () => {
    const status = await indexStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      structuredContent: status,
    };
  },
);

await server.connect(new StdioServerTransport());

