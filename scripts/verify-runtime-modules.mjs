import tls from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import express from "express";
import mysql from "mysql2";
import pg from "pg";
import { WebSocket } from "ws";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("CREATE TABLE runtime_smoke (value INTEGER)");
sqlite.close();

tls.createSecureContext();
express();
mysql.escape("runtime-smoke");
new pg.Client({ connectionString: "postgresql://runtime:smoke@127.0.0.1/runtime" }).end();
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
