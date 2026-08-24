#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  hybridRetrieve,
  indexGraph,
  indexStatus,
  lexicalRank,
  loadGraph,
  rerank,
  synthesizeWithModel,
  type RankedNode,
} from "./core.js";

function option(name: string, fallback?: string): string | undefined {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function commandArgument(): string {
  return process.argv.slice(3).find((arg) => !arg.startsWith("--")) || "";
}

async function gitSha(): Promise<string> {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function runIndex(): Promise<void> {
  const graphPath = option("graph", "graphify-out/graph.json");
  const result = await indexGraph({
    graphPath,
    root: option("root", "."),
    project: option("project", "toss-portfolio-lens"),
    graphSha: option("sha") || await gitSha(),
    batchSize: Number(option("batch-size", "64")),
    concurrency: Number(option("concurrency", "4")),
    onProgress(done, total, reused) {
      if (done === total || done % 256 === 0) {
        process.stderr.write(`[graphify-hybrid] embedded ${done}/${total}; reused ${reused}\n`);
      }
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

async function runQuery(): Promise<void> {
  const question = commandArgument();
  if (!question) throw new Error("Usage: query \"<question>\"");
  const retrieval = await hybridRetrieve({
    question,
    graphPath: option("graph", "graphify-out/graph.json"),
    project: option("project", "toss-portfolio-lens"),
    topK: Number(option("top-k", "50")),
    seedCount: Number(option("seeds", "5")),
    depth: Number(option("depth", "2")),
    contextFilters: (option("context", "") || "").split(",").filter(Boolean),
    useReranker: !flag("no-reranker"),
  });
  const result = flag("no-synthesis")
    ? retrieval
    : { ...retrieval, synthesis: await synthesizeWithModel(retrieval) };
  console.log(JSON.stringify(result, null, 2));
}

type BenchmarkCase = { question: string; expected: string[]; kind: "exact" | "semantic" };

const BENCHMARK_CASES: BenchmarkCase[] = [
  { question: "RunRepository", expected: ["server_repositories_run_repository_runrepository"], kind: "exact" },
  { question: "TechnicalAnalysisService", expected: ["server_services_technical_analysis_service_technicalanalysisservice"], kind: "exact" },
  { question: "createToolHandlers", expected: ["server_mcp_tools_handlers_createtoolhandlers"], kind: "exact" },
  { question: "PortfolioBacktestService.prepare", expected: ["server_backtest_portfoliobacktestservice_prepare"], kind: "exact" },
  { question: "KisWebSocketClient", expected: ["server_scalping_kis_websocket_client_kiswebsocketclient"], kind: "exact" },
  { question: "포트폴리오 실행 기록을 저장하고 조회하는 저장소", expected: ["server_repositories_run_repository_runrepository"], kind: "semantic" },
  { question: "과거 포트폴리오 스냅샷을 관리하는 저장소", expected: ["server_history_portfoliohistorystore"], kind: "semantic" },
  { question: "수익률 시계열을 만드는 서비스", expected: ["server_services_return_series_service_returnseriesservice"], kind: "semantic" },
  { question: "미국 종목 단타 후보 순위를 다시 매기는 함수", expected: ["server_scalping_scalping_service_rerankuskisrankings"], kind: "semantic" },
  { question: "포트폴리오 가중치를 최적화하는 Rust 함수", expected: ["worker_rust_src_optimization_optimize_with_control"], kind: "semantic" },
  { question: "OAuth 데이터를 영구 저장하는 repository", expected: ["server_repositories_oauth_repository_oauthrepository"], kind: "semantic" },
  { question: "실제 주문 없이 암호화폐 모의 실행을 담당하는 클래스", expected: ["server_crypto_execution_paperexecution"], kind: "semantic" },
];

function rankOf(ids: string[], expected: string[]): number | null {
  const index = ids.findIndex((id) => expected.includes(id));
  return index < 0 ? null : index + 1;
}

function metrics(ranks: Array<number | null>) {
  const recall = (k: number) => ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length;
  const mrr = ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length;
  return { recallAt1: recall(1), recallAt5: recall(5), recallAt10: recall(10), mrr };
}

async function runBenchmark(): Promise<void> {
  const graph = await loadGraph(option("graph", "graphify-out/graph.json"));
  const rows: Array<{
    question: string;
    kind: string;
    lexicalRank: number | null;
    hybridRank: number | null;
    rerankedRank: number | null;
  }> = [];
  for (const test of BENCHMARK_CASES) {
    const lexical = lexicalRank(graph, test.question, 50);
    const hybrid = await hybridRetrieve({
      question: test.question,
      graphPath: option("graph", "graphify-out/graph.json"),
      project: option("project", "toss-portfolio-lens"),
      topK: 50,
      seedCount: 10,
      depth: 0,
      useReranker: false,
    });
    const preRerankIds = hybrid.seeds.map((seed) => seed.nodeId);
    const rerankCandidates: RankedNode[] = hybrid.seeds;
    const reranked = await rerank(test.question, rerankCandidates, rerankCandidates.length);
    rows.push({
      question: test.question,
      kind: test.kind,
      lexicalRank: rankOf(lexical.map((row) => row.nodeId), test.expected),
      hybridRank: rankOf(preRerankIds, test.expected),
      rerankedRank: rankOf(reranked.map((row) => row.nodeId), test.expected),
    });
    process.stderr.write(`[benchmark] ${rows.length}/${BENCHMARK_CASES.length} ${test.kind}\n`);
  }
  const report = {
    cases: rows,
    lexical: metrics(rows.map((row) => row.lexicalRank)),
    hybridBeforeReranker: metrics(rows.map((row) => row.hybridRank)),
    hybridAfterReranker: metrics(rows.map((row) => row.rerankedRank)),
    semanticOnly: {
      lexical: metrics(rows.filter((row) => row.kind === "semantic").map((row) => row.lexicalRank)),
      hybridBeforeReranker: metrics(rows.filter((row) => row.kind === "semantic").map((row) => row.hybridRank)),
      hybridAfterReranker: metrics(rows.filter((row) => row.kind === "semantic").map((row) => row.rerankedRank)),
    },
  };
  const output = option("out");
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "setup") {
    const { createDatabaseClient, setupSchema } = await import("./core.js");
    const client = createDatabaseClient();
    await client.connect();
    try {
      await setupSchema(client);
    } finally {
      await client.end();
    }
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  if (command === "index") return runIndex();
  if (command === "query") return runQuery();
  if (command === "benchmark") return runBenchmark();
  if (command === "status") {
    console.log(JSON.stringify(await indexStatus(option("project", "toss-portfolio-lens")), null, 2));
    return;
  }
  throw new Error("Usage: graphify-hybrid <setup|index|query|benchmark|status>");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
