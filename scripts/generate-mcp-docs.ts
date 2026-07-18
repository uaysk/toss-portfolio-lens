import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, mcpJsonSchemas, mcpOutputJsonSchema, mcpSchemaHash } from "../server/build-info.js";
import { toolMetadata } from "../server/mcp/tools/metadata.js";

const root = process.cwd();
const contractPath = path.join(root, "server/mcp/generated-contract.json");
const readmePath = path.join(root, "README.md");
const startMarker = "<!-- MCP_TOOLS:START -->";
const endMarker = "<!-- MCP_TOOLS:END -->";
const check = process.argv.includes("--check");

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

const schemas = mcpJsonSchemas();
const outputSchemaHash = hash(mcpOutputJsonSchema());
const tools = Object.keys(toolMetadata).map((name) => {
  const metadata = toolMetadata[name as keyof typeof toolMetadata];
  return {
    name,
    inputSchemaHash: hash(schemas[name]),
    outputSchemaHash,
    title: metadata.title,
    description: metadata.description,
    scopes: metadata.scopes,
    annotations: metadata.annotations,
  };
});
const contract = `${JSON.stringify({
  formatVersion: 2,
  toolCount: tools.length,
  schemaHash: mcpSchemaHash(),
  tools,
}, null, 2)}\n`;

const table = [
  `${startMarker}\n<!-- \`npm run docs:mcp\`가 이 구간을 생성합니다. -->`,
  `\n현재 MCP 도구 수는 **${tools.length}개**, canonical input/output schema hash는 \`${mcpSchemaHash()}\`입니다.`,
  "\n| 도구 | 기능 | 기존 OAuth scope |",
  "| --- | --- | --- |",
  ...tools.map((tool) => `| \`${tool.name}\` | ${tool.description.replaceAll("|", "\\|")} | ${tool.scopes.map((scope) => `\`${scope}\``).join(", ")} |`),
  endMarker,
].join("\n");

const readme = await readFile(readmePath, "utf8");
const start = readme.indexOf(startMarker);
const end = readme.indexOf(endMarker);
if (start < 0 || end < start) throw new Error("README MCP marker가 없습니다.");
const nextReadme = `${readme.slice(0, start)}${table}${readme.slice(end + endMarker.length)}`;

if (check) {
  const existingContract = await readFile(contractPath, "utf8").catch(() => "");
  if (existingContract !== contract || readme !== nextReadme) {
    throw new Error("MCP contract/README가 코드와 다릅니다. npm run docs:mcp를 실행하세요.");
  }
} else {
  await writeFile(contractPath, contract, "utf8");
  await writeFile(readmePath, nextReadme, "utf8");
}
