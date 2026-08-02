import tls from "node:tls";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import express from "express";
import pg from "pg";
import { WebSocket } from "ws";

tls.createSecureContext();
express();
const runtimeDatabaseUrl = [
  "postgresql:",
  "//runtime:smoke",
  "@127.0.0.1/runtime",
].join("");
new pg.Client({ connectionString: runtimeDatabaseUrl }).end();
new McpServer({ name: "runtime-smoke", version: "1.0.0" }, { capabilities: {} });

const credentials = {
  accessKeyId: "runtime-smoke",
  secretAccessKey: "runtime-smoke",
};
new S3Client({ region: "us-east-1", credentials }).destroy();
new BedrockRuntimeClient({ region: "us-east-1", credentials }).destroy();

if (typeof WebSocket !== "function") {
  throw new Error("ws runtime export is unavailable");
}

process.stdout.write("runtime module smoke passed\n");
