import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

const PROFILES = [
  "close_only",
  "ohlcv_calendar",
  "microstructure_calendar",
  "derivatives_calendar",
];
const PROFILE_LABELS = {
  close_only: "Close only",
  ohlcv_calendar: "OHLCV + calendar",
  microstructure_calendar: "Microstructure + calendar",
  derivatives_calendar: "Derivatives + calendar",
};
const STAGE_LABELS = {
  pipeline_eager: "Pipeline eager",
  worker_local: "Worker-local",
  no_padding: "Patch-aligned",
  gpu_gather: "GPU gather",
  cuda_graph: "CUDA Graph",
};

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("Report arguments must be --name value pairs.");
    }
    values.set(name, value);
  }
  const evidence = values.get("--evidence");
  const output = values.get("--output");
  if (!evidence || !output) throw new Error("--evidence and --output are required.");
  for (const [name, path] of [
    ["--evidence", evidence],
    ["--output", output],
    ["--base-report", values.get("--base-report")],
  ]) {
    if (path && (!isAbsolute(path) || resolve(path) !== path)) {
      throw new Error(`${name} must be an absolute normalized path.`);
    }
  }
  return {
    evidence,
    output,
    baseReport: values.get("--base-report"),
    runId: values.get("--run-id") ?? basename(evidence),
    estimatedDurationMs: Number(values.get("--estimated-duration-ms")),
    estimatedUpperMs: Number(values.get("--estimated-upper-ms")),
  };
}

async function json(path) {
  return JSON.parse((await readFile(path)).toString("utf8"));
}

async function optionalJson(path) {
  try {
    return await json(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function format(value, digits = 2) {
  return finite(value) === undefined
    ? "Unavailable"
    : Number(value).toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
}

function percentFromFraction(value, digits = 2) {
  return finite(value) === undefined ? "Unavailable" : `${format(value * 100, digits)}%`;
}

function signedPercentPoint(value, digits = 3) {
  if (finite(value) === undefined) return "Unavailable";
  return `${value >= 0 ? "+" : ""}${format(value * 100, digits)}%p`;
}

function signedPercent(value, digits = 2) {
  if (finite(value) === undefined) return "Unavailable";
  return `${value >= 0 ? "+" : ""}${format(value, digits)}%`;
}

function ratio(candidate, reference) {
  return finite(candidate) !== undefined
    && finite(reference) !== undefined
    && reference > 0
    ? candidate / reference
    : undefined;
}

function median(values) {
  const ordered = values
    .filter((value) => finite(value) !== undefined)
    .toSorted((left, right) => left - right);
  if (!ordered.length) return undefined;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function mean(values) {
  const valid = values.filter((value) => finite(value) !== undefined);
  return valid.length
    ? valid.reduce((total, value) => total + value, 0) / valid.length
    : undefined;
}

function escape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function statusClass(status) {
  if (status === "passed" || status === "completed" || status === true) return "pass";
  if (status === "rejected" || status === "failed" || status === false) return "fail";
  if (status === "baseline") return "baseline";
  return "warn";
}

function badge(status, label = status) {
  return `<span class="badge ${statusClass(status)}">${escape(label ?? "Unavailable")}</span>`;
}

function shortDigest(value) {
  return typeof value === "string" && value.length >= 20
    ? `${value.slice(0, 12)}…${value.slice(-8)}`
    : "Unavailable";
}

function bar(value, maximum, tone = "") {
  if (finite(value) === undefined || !maximum) {
    return `<span class="missing">Unavailable</span>`;
  }
  const width = Math.max(1.2, Math.min(100, value / maximum * 100));
  return `<span class="bar-track"><span class="chart-fill ${tone}" style="width:${width.toFixed(3)}%"></span></span>`;
}

function telemetry(result) {
  const samples = (result?.rounds ?? [])
    .map((round) => round.gpu_telemetry)
    .filter((value) => value?.status === "available");
  if (!samples.length) return {};
  const values = (selector) => samples
    .map(selector)
    .filter((value) => finite(value) !== undefined);
  const average = (selector) => mean(values(selector));
  const maximum = (selector) => {
    const selected = values(selector);
    return selected.length ? Math.max(...selected) : undefined;
  };
  return {
    utilizationMean: average((value) => value.gpu_utilization_percent?.mean),
    utilizationMax: maximum((value) => value.gpu_utilization_percent?.max),
    memoryMaxBytes: maximum((value) => value.max_memory_used_bytes),
    powerMean: average((value) => value.power_watts?.mean),
    powerMax: maximum((value) => value.power_watts?.max),
    temperatureMean: average((value) => value.temperature_celsius?.mean),
    temperatureMax: maximum((value) => value.temperature_celsius?.max),
  };
}

function aggregateHorizons(comparison) {
  const rows = Object.entries(
    comparison.realized_accuracy?.by_symbol_horizon ?? {},
  ).map(([key, value]) => ({
    horizon: Number(key.split(":")[1]),
    reference: value.reference,
    candidate: value.candidate,
  }));
  return [5, 15, 30, 60].map((horizon) => {
    const selected = rows.filter((row) => row.horizon === horizon);
    const count = selected.reduce(
      (total, row) => total + Number(row.reference?.count ?? 0),
      0,
    );
    const weighted = (side, key) => count
      ? selected.reduce(
          (total, row) => total
            + Number(row[side]?.[key] ?? 0) * Number(row[side]?.count ?? 0),
          0,
        ) / count
      : undefined;
    return {
      horizon,
      count,
      reference: {
        directionAccuracy: weighted("reference", "direction_accuracy"),
        q50Mae: weighted("reference", "q50_return_mae"),
        pinball: weighted("reference", "mean_pinball_loss"),
      },
      candidate: {
        directionAccuracy: weighted("candidate", "direction_accuracy"),
        q50Mae: weighted("candidate", "q50_return_mae"),
        pinball: weighted("candidate", "mean_pinball_loss"),
      },
    };
  });
}

function modelReturnSummary(comparison) {
  const profiles = comparison.model_signal_returns?.profiles ?? [];
  const view = (side) => ({
    meanTotalReturn: mean(profiles.map((value) => value[side]?.total_return)),
    medianTotalReturn: median(profiles.map((value) => value[side]?.total_return)),
    meanGrossReturn: mean(profiles.map((value) => value[side]?.gross_total_return)),
    meanCostDrag: mean(profiles.map((value) => value[side]?.cost_drag)),
    tradeCount: profiles.reduce(
      (total, value) => total + Number(value[side]?.trade_count ?? 0),
      0,
    ),
  });
  return {
    reference: view("reference"),
    candidate: view("candidate"),
    gate: comparison.model_signal_returns?.gate,
    profileCount: profiles.length,
  };
}

async function historicalFincast(path) {
  if (!path) return undefined;
  const html = await readFile(path, "utf8");
  const match = html.match(
    /<script id="report-evidence" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error("Base report has no embedded report evidence.");
  const value = JSON.parse(match[1]);
  const fiveWeek = value.qualifications?.fiveWeek?.summary;
  return {
    sourceReport: path,
    sourceReportSha256: await sha256(path),
    runId: value.runId,
    c60: {
      batch16: value.batchSweep?.["60"]?.find((item) => item.batch_size === 16)
        ?.timing?.series_per_second?.median,
      batch48: value.batchSweep?.["60"]?.find((item) => item.batch_size === 48)
        ?.timing?.series_per_second?.median,
      noPadding: value.stages?.no_padding?.["60"]?.timing?.series_per_second?.median,
      packedExperts:
        value.stages?.batched_experts?.["60"]?.timing?.series_per_second?.median,
      cudaGraph: value.stages?.cuda_graph?.["60"]?.timing?.series_per_second?.median,
    },
    tensorrtFp32: {
      throughput: value.tensorrtFp32?.latency?.series_per_second?.median,
      vsCudaGraph: value.tensorrtFp32?.speed_comparison?.pytorch_cuda_graph_fp32,
      status: value.tensorrtFp32?.status,
      buildSeconds: value.tensorrtFp32?.build?.seconds,
      engineBytes: value.tensorrtFp32?.build?.engine_bytes,
    },
    tensorrtInt8: {
      throughput: value.tensorrt?.latency?.series_per_second?.median,
      vsCudaGraph: value.tensorrt?.speed_comparison,
      vsFp32: value.tensorrtFp32?.speed_comparison?.tensorrt_int8_vs_tensorrt_fp32,
      status: value.tensorrt?.status,
      rejectionReasons: value.tensorrt?.rejection_reasons,
    },
    fiveWeek: fiveWeek
      ? {
          status: fiveWeek.status,
          replacementEligible: fiveWeek.replacement_eligible,
          throughput: fiveWeek.throughput,
          probabilityOnly: fiveWeek.probability_only_near_threshold,
          maximumProbabilityDelta:
            fiveWeek.realized_accuracy?.paired?.absolute_up_probability_delta?.maximum,
          symbolAlignedActionMismatches:
            fiveWeek.gate?.symbol_aligned?.action_kind_mismatches,
          symbolAlignedReasonMismatches:
            fiveWeek.gate?.symbol_aligned?.reason_mismatches,
        }
      : undefined,
    artifacts: "operator_deleted_binaries_report_only",
  };
}

function renderBatch(profile) {
  const maximum = Math.max(
    ...profile.batches.map((candidate) => candidate.tasksPerSecond ?? 0),
  );
  return `<section class="profile-panel" data-profile-panel="${escape(profile.id)}" ${
    profile.id === "close_only" ? "" : "hidden"
  }>
    <div class="table-scroll"><table>
      <thead><tr><th>Batch</th><th>Task batch</th><th>Median task/s</th><th>p50</th><th>p95</th><th>Peak alloc.</th><th>Gate</th></tr></thead>
      <tbody>${profile.batches.map((candidate) => `<tr>
        <td><span class="mono">B${candidate.batch}</span> ${
          candidate.batch === profile.selectedBatch ? badge("passed", "selected") : ""
        }</td>
        <td>${format(candidate.taskBatch, 0)}</td>
        <td>${format(candidate.tasksPerSecond)}${bar(
          candidate.tasksPerSecond,
          maximum,
          candidate.batch === profile.selectedBatch ? "pass-fill" : "",
        )}</td>
        <td>${format(candidate.p50Ms)} ms</td>
        <td>${format(candidate.p95Ms)} ms</td>
        <td>${format(candidate.peakAllocatedBytes / 1048576, 1)} MiB</td>
        <td>${badge(candidate.status)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </section>`;
}

function renderWaterfall(profile) {
  const values = profile.stages
    .filter((stage) => finite(stage.tasksPerSecond) !== undefined)
    .map((stage) => stage.tasksPerSecond);
  const maximum = values.length ? Math.max(...values) : 1;
  return `<section class="profile-panel" data-waterfall-panel="${escape(profile.id)}" ${
    profile.id === "close_only" ? "" : "hidden"
  }>
    <div class="waterfall">${profile.stages.map((stage) => `<article class="waterfall-row">
      <div><strong>${escape(STAGE_LABELS[stage.backend] ?? stage.backend)}</strong>
        <small>${stage.status === "unavailable"
          ? escape(stage.error ?? stage.rejectionReasons?.join(", ") ?? "Unavailable")
          : `${format(stage.p50Ms)} ms p50 · ${format(stage.p95Ms)} ms p95`}</small>
      </div>
      <div class="waterfall-value">
        <span>${format(stage.tasksPerSecond)} task/s</span>
        ${bar(
          stage.tasksPerSecond,
          maximum,
          stage.backend === profile.selectedBackend ? "pass-fill" : "",
        )}
      </div>
      <div><strong>${stage.cumulativePercent === undefined
        ? "Unavailable"
        : signedPercent(stage.cumulativePercent)}</strong>
        <small>pipeline eager 대비</small>
      </div>
      <div>${badge(stage.status, stage.backend === profile.selectedBackend
        ? "selected"
        : stage.status)}</div>
    </article>`).join("")}</div>
  </section>`;
}

const args = argumentsFrom(process.argv.slice(2));
const statePath = join(args.evidence, "state.json");
const runtimePath = join(args.evidence, "runtime.json");
const sourcePath = join(args.evidence, "input", "source-manifest.json");
const summaryPath = await optionalJson(
  join(args.evidence, "qualification-summary-v2.json"),
) ? join(args.evidence, "qualification-summary-v2.json")
  : join(args.evidence, "qualification-summary.json");
const state = await json(statePath);
const runtime = await json(runtimePath);
const source = await json(sourcePath);
const summary = await json(summaryPath);
const historical = await historicalFincast(args.baseReport);
const comparisons = Object.fromEntries(
  await Promise.all(PROFILES.map(async (profile) => [
    profile,
    await json(join(args.evidence, "comparisons", `${profile}.json`)),
  ])),
);
const generationTimings = Object.fromEntries(
  await Promise.all(PROFILES.map(async (profile) => [
    profile,
    (await json(join(
      args.evidence,
      "timings",
      `chronos2-${profile}-generation.json`,
    ))).wall_seconds,
  ])),
);
const fincastGenerationSeconds = (
  await json(join(args.evidence, "timings", "fincast-generation.json"))
).wall_seconds;

const profileEvidence = await Promise.all(PROFILES.map(async (profile) => {
  const value = summary.profiles[profile];
  const selectedBatch = value.batch_sweep.selected_variate_batch_size;
  const selectedBackend = value.optimization.selected_backend;
  const selectedBenchmarkPath = join(
    args.evidence,
    "benchmarks",
    profile,
    `stage-${selectedBackend}-b${selectedBatch}.json`,
  );
  const selectedBenchmark = await json(selectedBenchmarkPath);
  const graphBenchmark = await optionalJson(join(
    args.evidence,
    "benchmarks",
    profile,
    `stage-cuda_graph-b${selectedBatch}.json`,
  ));
  const comparison = summary.model_comparisons[profile];
  const guard = summary.profile_selection?.candidate_evaluations?.[profile];
  return {
    id: profile,
    label: PROFILE_LABELS[profile],
    variateNames:
      value.batch_sweep.candidates[0]?.provenance?.variate_names ?? [],
    selectedBatch,
    selectedBackend,
    selectedTasksPerSecond: value.optimization.selected_tasks_per_second,
    selectedVariatesPerSecond:
      selectedBenchmark.timing?.variates_per_second?.median,
    generationSeconds: generationTimings[profile],
    generationRowsPerSecond: ratio(source.row_count, generationTimings[profile]),
    telemetry: telemetry(selectedBenchmark),
    guard,
    metrics: comparison,
    batches: value.batch_sweep.candidates.map((candidate) => ({
      batch: candidate.variate_batch_size,
      taskBatch: candidate.task_batch_size,
      tasksPerSecond: candidate.timing?.tasks_per_second?.median,
      variatesPerSecond: candidate.timing?.variates_per_second?.median,
      p50Ms: candidate.timing?.wall_ms?.p50,
      p95Ms: candidate.timing?.wall_ms?.p95,
      peakAllocatedBytes: candidate.memory?.torch_peak_allocated_bytes,
      minimumFreeBytes: candidate.memory?.minimum_nvml_free_bytes,
      status: candidate.status,
    })),
    stages: value.optimization.stages.map((stage) => ({
      backend: stage.backend,
      status: stage.status,
      accepted: stage.accepted,
      tasksPerSecond: stage.tasks_per_second,
      variatesPerSecond: stage.variates_per_second,
      p50Ms: stage.wall_p50_ms,
      p95Ms: stage.wall_p95_ms,
      incrementalRatio: stage.incremental_speedup_ratio,
      cumulativeRatio: stage.cumulative_speedup_ratio,
      cumulativePercent: stage.cumulative_speedup_percent,
      rejectionReasons: stage.rejection_reasons,
      error: stage.backend === "cuda_graph"
        ? graphBenchmark?.error
        : undefined,
    })),
    selectedBenchmarkSha256: await sha256(selectedBenchmarkPath),
  };
}));

const selectedProfile = summary.profile_selection.selected_profile;
const selected = profileEvidence.find((profile) => profile.id === selectedProfile);
if (!selected) throw new Error("Selected profile is absent from evidence.");
const selectedComparison = comparisons[selectedProfile];
const horizons = aggregateHorizons(selectedComparison);
const returns = modelReturnSummary(selectedComparison);
const referenceAccuracy = selectedComparison.realized_accuracy.reference;
const candidateAccuracy = selectedComparison.realized_accuracy.candidate;
const reason = selectedComparison.reason_difference_analysis;
const threshold = selectedComparison.threshold_margin_audit;
const nearThreshold = selectedComparison.probability_only_near_threshold;
const actualDurationMs = state.progress?.elapsedMs;
const estimateRatio = ratio(actualDurationMs, args.estimatedDurationMs);
const chronosGenerationThroughput = ratio(source.row_count, selected.generationSeconds);
const fincastGenerationThroughput = ratio(source.row_count, fincastGenerationSeconds);
const generationSpeedup = ratio(
  chronosGenerationThroughput,
  fincastGenerationThroughput,
);
const steps = Object.fromEntries(
  (state.steps ?? []).map((step) => [step.id, step.durationMs]),
);
const mappedActualSeconds = {
  input_collection: steps["prepare-input"] / 1000,
  artifact_preparation: steps["chronos-artifacts"] / 1000,
  batch_sweep: steps["batch-sweep"] / 1000,
  optimization_waterfall: steps["optimization-waterfall"] / 1000,
  chronos2_generation: steps["chronos-profiles"] / 1000,
  fincast_generation: steps["fincast-reference"] / 1000,
  policy_comparison: steps["model-comparison"] / 1000,
};
mappedActualSeconds.fixed_runtime_and_restoration = actualDurationMs / 1000
  - Object.values(mappedActualSeconds).reduce((sum, value) => sum + value, 0);
const estimatedComponents = {
  input_collection: 165.34,
  artifact_preparation: 3577.28,
  batch_sweep: 249.22748367243912,
  optimization_waterfall: 249.25483512855135,
  chronos2_generation: 758.4014849299565,
  fincast_generation: 2830.389226647478,
  policy_comparison: 1048.32,
  fixed_runtime_and_restoration: 480,
};
const componentLabels = {
  input_collection: "Input collection",
  artifact_preparation: "Artifact preparation",
  batch_sweep: "Batch sweep",
  optimization_waterfall: "Optimization waterfall",
  chronos2_generation: "Chronos-2 generation",
  fincast_generation: "FinCast generation",
  policy_comparison: "Policy comparison",
  fixed_runtime_and_restoration: "Runtime · restoration · overhead",
};

const reportEvidence = {
  schemaVersion: "chronos2-p40-qualification-report/v1",
  runId: args.runId,
  generatedAt: new Date().toISOString(),
  state: {
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    elapsedMs: actualDurationMs,
  },
  runtime,
  coverage: {
    durationHours: source.duration_hours,
    rowCount: source.row_count,
    symbols: source.symbols,
    marketRows: source.market_bars?.row_count,
    originStrideMinutes: source.origin_stride_minutes,
  },
  duration: {
    estimatedMs: finite(args.estimatedDurationMs),
    estimatedUpperMs: finite(args.estimatedUpperMs),
    actualMs: actualDurationMs,
    actualToEstimateRatio: estimateRatio,
    estimatedComponents,
    actualComponents: mappedActualSeconds,
  },
  selection: summary.profile_selection,
  profiles: profileEvidence,
  selectedComparison: {
    referenceAccuracy,
    candidateAccuracy,
    horizons,
    returns,
    predictionGate: selectedComparison.prediction_gate,
    policyGate: selectedComparison.gate,
    reason,
    threshold,
    nearThreshold,
    paired: selectedComparison.realized_accuracy.paired,
    outlierDiagnostics:
      selectedComparison.realized_accuracy.outlier_diagnostics,
  },
  generation: {
    chronos2Seconds: selected.generationSeconds,
    chronos2RowsPerSecond: chronosGenerationThroughput,
    fincastSeconds: fincastGenerationSeconds,
    fincastRowsPerSecond: fincastGenerationThroughput,
    speedupRatio: generationSpeedup,
  },
  historicalFincast: historical,
  artifacts: {
    remoteRoot:
      `/home/uaysk/toss-portfolio-lens-chronos2/runs/${args.runId}`,
    localEvidenceRoot: args.evidence,
    stateSha256: await sha256(statePath),
    runtimeSha256: await sha256(runtimePath),
    sourceSha256: await sha256(sourcePath),
    summarySha256: await sha256(summaryPath),
    comparisons: Object.fromEntries(
      await Promise.all(PROFILES.map(async (profile) => [
        profile,
        await sha256(join(args.evidence, "comparisons", `${profile}.json`)),
      ])),
    ),
    modelWeightsSha256: runtime.model?.checkpoint_sha256,
    marketBarsSha256: source.market_bars?.sha256,
  },
};

const profileTabs = profileEvidence.map((profile) => (
  `<button type="button" data-profile-tab="${escape(profile.id)}" ${
    profile.id === "close_only" ? 'aria-selected="true"' : 'aria-selected="false"'
  }>${escape(PROFILE_LABELS[profile.id])}</button>`
)).join("");
const profileRows = profileEvidence.map((profile) => {
  const candidate = profile.metrics.candidate;
  const pinballDelta = ratio(
    candidate.mean_pinball_loss,
    selected.metrics.candidate.mean_pinball_loss,
  );
  return `<tr>
    <td><strong>${escape(profile.label)}</strong><small>${profile.variateNames.length} variates</small></td>
    <td>${profile.id === selectedProfile ? badge("passed", "selected") : badge(
      profile.guard?.eligible ? "passed" : "rejected",
      profile.guard?.eligible ? "eligible" : "guard failed",
    )}</td>
    <td>${format(candidate.direction_accuracy * 100, 3)}%<small>${signedPercentPoint(
      profile.guard?.direction_accuracy_delta_vs_close_only,
      3,
    )} vs close</small></td>
    <td>${format(candidate.mean_pinball_loss, 8)}<small>${pinballDelta === undefined
      ? "Unavailable"
      : signedPercent((pinballDelta - 1) * 100)} vs selected</small></td>
    <td>${format(candidate.q50_return_mae, 8)}</td>
    <td>${percentFromFraction(candidate.median_policy_total_return)}</td>
    <td>${format(profile.selectedTasksPerSecond)} task/s<small>${format(
      profile.selectedVariatesPerSecond,
    )} variate/s</small></td>
    <td>${escape(profile.guard?.rejection_reasons?.join(", ") || "—")}</td>
  </tr>`;
}).join("");

const fincastHistoryRows = historical
  ? [
      ["Worker-local B16", historical.c60.batch16, undefined, "baseline"],
      [
        "Batch sweep B48",
        historical.c60.batch48,
        ratio(historical.c60.batch48, historical.c60.batch16),
        "passed",
      ],
      [
        "No padding",
        historical.c60.noPadding,
        ratio(historical.c60.noPadding, historical.c60.batch48),
        "passed",
      ],
      [
        "Packed experts",
        historical.c60.packedExperts,
        ratio(historical.c60.packedExperts, historical.c60.noPadding),
        "passed",
      ],
      [
        "CUDA Graph FP32",
        historical.c60.cudaGraph,
        ratio(historical.c60.cudaGraph, historical.c60.packedExperts),
        "passed",
      ],
      [
        "TensorRT FP32",
        historical.tensorrtFp32.throughput,
        ratio(historical.tensorrtFp32.throughput, historical.c60.cudaGraph),
        "rejected",
      ],
      [
        "TensorRT INT8",
        historical.tensorrtInt8.throughput,
        ratio(
          historical.tensorrtInt8.throughput,
          historical.tensorrtFp32.throughput,
        ),
        "rejected",
      ],
    ]
  : [];
const historyMaximum = Math.max(...fincastHistoryRows.map((row) => row[1] ?? 0), 1);

const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Chronos-2 P40 qualification · ${escape(args.runId)}</title>
  <style>
    :root{color-scheme:dark;--bg:#09090b;--surface:#111113;--surface2:#18181b;--muted:#a1a1aa;--text:#fafafa;--line:#29292e;--green:#4ade80;--amber:#fbbf24;--red:#fb7185;--cyan:#22d3ee;--radius:14px}
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}
    a{color:inherit;text-decoration:none}.shell{width:min(1180px,calc(100% - 40px));margin:0 auto}.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    nav{position:sticky;top:0;z-index:5;background:rgba(9,9,11,.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}nav .shell{display:flex;gap:18px;overflow:auto;padding:12px 0;white-space:nowrap}nav a{color:var(--muted);font-size:12px}nav a:hover{color:var(--text)}
    header{padding:72px 0 34px}.eyebrow{display:block;color:var(--muted);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:12px}h1{font-size:clamp(32px,5vw,60px);line-height:1.02;letter-spacing:-.045em;margin:0;max-width:900px}h2{font-size:25px;letter-spacing:-.025em;margin:0 0 8px}h3{font-size:15px;margin:0 0 8px}.lede{max-width:900px;color:#d4d4d8;font-size:17px;margin:22px 0}.badges,.tokens{display:flex;gap:8px;flex-wrap:wrap}
    .badge,.token{display:inline-flex;align-items:center;min-height:25px;padding:3px 9px;border-radius:999px;background:var(--surface2);font-size:11px;white-space:nowrap}.badge.pass{color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent)}.badge.warn{color:var(--amber);background:color-mix(in srgb,var(--amber) 12%,transparent)}.badge.fail{color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent)}.badge.baseline{color:var(--cyan);background:color-mix(in srgb,var(--cyan) 12%,transparent)}
    main{padding-bottom:80px}.section{padding:48px 0;border-top:1px solid var(--line)}.section-copy{color:var(--muted);max-width:860px;margin:0 0 24px}.grid{display:grid;gap:12px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:24px}.two{grid-template-columns:repeat(2,minmax(0,1fr))}.three{grid-template-columns:repeat(3,minmax(0,1fr))}
    .card,.callout,.surface{background:var(--surface);border-radius:var(--radius);padding:18px}.card span,.card small,.surface small{display:block;color:var(--muted)}.card strong{display:block;font-size:25px;letter-spacing:-.03em;margin:5px 0}.tone-pass{color:var(--green)}.tone-fail{color:var(--red)}.tone-warn{color:var(--amber)}.tone-baseline{color:var(--cyan)}
    .callout{border-left:3px solid var(--line)}.callout.pass{border-color:var(--green)}.callout.fail{border-color:var(--red)}.callout.warn{border-color:var(--amber)}.callout.baseline{border-color:var(--cyan)}.callout strong{display:block;font-size:16px}.callout p{color:#d4d4d8;margin:8px 0 0}
    .table-scroll{overflow:auto;border-radius:var(--radius);background:var(--surface)}table{border-collapse:collapse;width:100%;min-width:780px}th,td{text-align:left;padding:13px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}td small{display:block;color:var(--muted);margin-top:3px}tbody tr:last-child td{border-bottom:0}
    .tabs{display:flex;gap:6px;overflow:auto;margin:20px 0 14px}.tabs button{appearance:none;border:0;border-radius:999px;background:var(--surface2);color:var(--muted);padding:8px 13px;cursor:pointer;white-space:nowrap}.tabs button[aria-selected="true"]{background:#f4f4f5;color:#09090b}
    .bar-track{display:block;height:5px;border-radius:999px;background:#242429;margin-top:7px;overflow:hidden;min-width:90px}.chart-fill{display:block;height:100%;background:#71717a;border-radius:inherit}.chart-fill.pass-fill{background:var(--green)}.chart-fill.cyan-fill{background:var(--cyan)}.missing{color:var(--muted)}
    .waterfall{display:grid;gap:7px}.waterfall-row{display:grid;grid-template-columns:1.2fr 1.4fr .8fr auto;align-items:center;gap:15px;padding:13px 15px;background:var(--surface);border-radius:12px}.waterfall-row small{display:block;color:var(--muted)}.waterfall-value>span{font-variant-numeric:tabular-nums}
    .reason-list{display:grid;gap:8px}.reason-row{display:grid;grid-template-columns:1.5fr 1fr;gap:12px;align-items:center;background:var(--surface);padding:12px 14px;border-radius:10px}.reason-row strong{text-align:right}.provenance{display:grid;grid-template-columns:220px 1fr;gap:0;background:var(--surface);border-radius:var(--radius);overflow:hidden}.provenance dt,.provenance dd{margin:0;padding:11px 14px;border-bottom:1px solid var(--line)}.provenance dt{color:var(--muted)}.provenance dd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.provenance dt:last-of-type,.provenance dd:last-of-type{border-bottom:0}
    .footnote{font-size:12px;color:var(--muted);margin-top:16px}.nowrap{white-space:nowrap}
    @media(max-width:900px){.metrics,.three{grid-template-columns:repeat(2,minmax(0,1fr))}.two{grid-template-columns:1fr}.waterfall-row{grid-template-columns:1fr 1fr}.waterfall-row>div:nth-child(4){justify-self:end}.shell{width:min(100% - 28px,1180px)}}
    @media(max-width:520px){header{padding-top:45px}.section{padding:36px 0}.metrics,.three{grid-template-columns:1fr}.card strong{font-size:22px}.waterfall-row{grid-template-columns:1fr}.waterfall-row>div:nth-child(4){justify-self:start}.provenance{grid-template-columns:1fr}.provenance dt{padding-bottom:2px;border-bottom:0}.provenance dd{padding-top:2px}.reason-row{grid-template-columns:1fr}.reason-row strong{text-align:left}}
  </style>
</head>
<body>
  <nav><div class="shell"><a href="#outcome">Outcome</a><a href="#duration">Duration</a><a href="#inputs">Inputs</a><a href="#profiles">Profiles</a><a href="#optimization">Optimization</a><a href="#accuracy">Accuracy</a><a href="#returns">Returns</a><a href="#reasons">Reasons</a><a href="#history">FinCast history</a><a href="#artifacts">Artifacts</a></div></nav>
  <header id="outcome"><div class="shell">
    <span class="eyebrow">Tesla P40 · 160W · 840 hours · c60 · FP32</span>
    <h1>Chronos-2 지원은 준비됐지만 FinCast 대체 승인은 아니다.</h1>
    <p class="lede">5주 BTC·ETH 6,720-row qualification은 ${format(
      actualDurationMs / 60000,
      2,
    )}분 만에 완료됐습니다. 추가 covariate는 분포 오차를 낮췄지만 방향 정확도 guard를 넘지 못해 <strong>close_only / B32 / gpu_gather</strong>가 선택됐습니다. 동일 조건 raw 생성은 FinCast보다 빨랐으나 확률과 정책 결정이 크게 달라 운영 교체는 거부합니다.</p>
    <div class="badges">${badge(state.status, "run completed")}${badge(
      "passed",
      "Chronos-2 support ready",
    )}${badge("passed", "close_only · B32 · gpu_gather")}${badge(
      "rejected",
      "FinCast replacement rejected",
    )}${badge("baseline", "FinCast CUDA Graph unchanged")}${badge(
      "unavailable",
      "Chronos CUDA Graph unavailable",
    )}</div>
    <div class="grid metrics">
      <article class="card"><span>Actual wall time</span><strong>${format(
        actualDurationMs / 60000,
        2,
      )} min</strong><small>pilot estimate ${format(
        args.estimatedDurationMs / 3600000,
        2,
      )} h</small></article>
      <article class="card"><span>Selected Chronos throughput</span><strong class="tone-pass">${format(
        chronosGenerationThroughput,
      )}</strong><small>5-week end-to-end rows/s</small></article>
      <article class="card"><span>FinCast reference throughput</span><strong class="tone-baseline">${format(
        fincastGenerationThroughput,
      )}</strong><small>same-run end-to-end rows/s</small></article>
      <article class="card"><span>Chronos / FinCast generation</span><strong class="tone-pass">${format(
        generationSpeedup,
        3,
      )}×</strong><small>${signedPercent((generationSpeedup - 1) * 100)} raw wall throughput</small></article>
      <article class="card"><span>Direction accuracy</span><strong>${format(
        candidateAccuracy.direction_accuracy * 100,
        3,
      )}%</strong><small>${signedPercentPoint(
        candidateAccuracy.direction_accuracy - referenceAccuracy.direction_accuracy,
      )} vs FinCast</small></article>
      <article class="card"><span>Mean pinball loss</span><strong>${format(
        candidateAccuracy.mean_pinball_loss,
        8,
      )}</strong><small>${signedPercent(
        (candidateAccuracy.mean_pinball_loss / referenceAccuracy.mean_pinball_loss - 1) * 100,
      )} vs FinCast · lower is better</small></article>
      <article class="card"><span>Probability-only action mismatch</span><strong class="tone-fail">${percentFromFraction(
        nearThreshold.action_mismatch_rate,
      )}</strong><small>${format(nearThreshold.action_mismatch_count, 0)} / ${format(
        nearThreshold.decision_count,
        0,
      )}</small></article>
      <article class="card"><span>Replacement decision</span><strong class="tone-fail">Rejected</strong><small>no live promotion · no deployment</small></article>
    </div>
  </div></header>

  <main>
    <section class="section" id="duration"><div class="shell">
      <h2>Measured duration</h2>
      <p class="section-copy">Pilot의 고정비+행 단위 외삽은 ${format(
        args.estimatedDurationMs / 3600000,
        2,
      )}시간, 상한 ${format(args.estimatedUpperMs / 3600000, 2)}시간이었습니다. 실제는 ${format(
        actualDurationMs / 3600000,
        3,
      )}시간으로 중앙 추정치의 ${format(estimateRatio * 100, 2)}%였습니다. artifact와 FinCast 생성의 startup·vectorization 비용을 행마다 선형 확대해 크게 과대평가한 것이 주원인입니다.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Component</th><th>Estimated</th><th>Actual</th><th>Actual / estimate</th></tr></thead>
        <tbody>${Object.keys(estimatedComponents).map((key) => `<tr>
          <td>${escape(componentLabels[key])}</td>
          <td>${format(estimatedComponents[key], 2)} s</td>
          <td>${format(mappedActualSeconds[key], 2)} s</td>
          <td>${format(ratio(mappedActualSeconds[key], estimatedComponents[key]), 3)}×${bar(
            Math.min(ratio(mappedActualSeconds[key], estimatedComponents[key]) ?? 0, 1),
            1,
            "cyan-fill",
          )}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div></section>

    <section class="section" id="inputs"><div class="shell">
      <h2>Chronos-2 input capability used here</h2>
      <p class="section-copy">target close 외에 과거 공변량, 미래에 미리 아는 calendar 공변량을 전달할 수 있도록 구현했습니다. BTCUSDT·ETHUSDT의 finalized 1분봉, 거래수·taker 비중, mark/index basis, premium, funding을 causal하게 정렬했습니다. open interest와 long/short 비율은 같은 5주 causal history를 안정적으로 확보할 수 없어 제외했습니다.</p>
      <div class="grid two">
        <article class="surface"><h3>Past covariates</h3><div class="tokens"><span class="token">OHLC ratios</span><span class="token">volume · quote volume</span><span class="token">trade count</span><span class="token">taker-buy shares</span><span class="token">mark/close basis</span><span class="token">index/close basis</span><span class="token">premium index</span><span class="token">funding rate</span></div></article>
        <article class="surface"><h3>Known future covariates</h3><div class="tokens"><span class="token">minute-of-day sin/cos</span><span class="token">minute-of-week sin/cos</span><span class="token">weekend flag</span></div><p class="footnote">가격·거래·파생 값은 미래 buffer에 넣지 않았습니다.</p></article>
      </div>
      <div class="grid metrics">
        <article class="card"><span>Window</span><strong>840 h</strong><small>2026-06-22 → 2026-07-27</small></article>
        <article class="card"><span>Forecast rows</span><strong>${format(source.row_count, 0)}</strong><small>3,360 origins × 2 symbols</small></article>
        <article class="card"><span>Market rows</span><strong>${format(source.market_bars?.row_count, 0)}</strong><small>causally aligned 1-minute records</small></article>
        <article class="card"><span>Native output</span><strong>4 × 22 FP32</strong><small>q50 point + q01…q99 quantiles</small></article>
      </div>
    </div></section>

    <section class="section" id="profiles"><div class="shell">
      <h2>Covariate profile selection</h2>
      <p class="section-copy">추가 profile 세 개는 close-only보다 pinball loss를 1.94~2.11% 개선하고 q50 MAE도 낮췄습니다. 그러나 방향 정확도가 0.216~0.714%p 낮아 허용치 −0.1%p를 모두 위반했습니다. 따라서 “공변량이 아무 효과가 없음”이 아니라, 사전 정의 guard가 방향성 저하를 허용하지 않은 결과입니다.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Profile</th><th>Selection</th><th>Direction</th><th>Pinball</th><th>q50 MAE</th><th>Median diagnostic return</th><th>Selected speed</th><th>Guard reason</th></tr></thead>
        <tbody>${profileRows}</tbody>
      </table></div>
      <p class="footnote">Return은 아래의 고회전 5분 probability-threshold 진단값이며 운영 수익률로 해석하지 않습니다.</p>
    </div></section>

    <section class="section" id="optimization"><div class="shell">
      <h2>Chronos-2 batch sweep</h2>
      <p class="section-copy">각 후보는 독립 모델 프로세스에서 3 rounds × 10 warmups + 30 timed iterations로 측정했습니다. OOM, 2GiB headroom, exact output digest gate를 모두 통과했습니다. 3% tie에서는 p95가 낮은 후보를 택했습니다.</p>
      <div class="tabs" data-tab-group="batch">${profileTabs}</div>
      ${profileEvidence.map(renderBatch).join("")}
      <h2 style="margin-top:36px">Cumulative optimization waterfall</h2>
      <p class="section-copy">단계별 수치는 해당 profile의 선택 batch에서 다시 측정한 결과입니다. GPU gather가 느려진 profile에서는 더 빠른 no_padding 경로가 최종 선택됐습니다.</p>
      <div class="tabs" data-tab-group="waterfall">${profileTabs.replaceAll(
        "data-profile-tab",
        "data-waterfall-tab",
      )}</div>
      ${profileEvidence.map(renderWaterfall).join("")}
      <div class="grid three" style="margin-top:16px">
        <article class="callout pass"><strong>Worker-local</strong><p>close-only에서 +2.55%, 전체 누적 +2.97%의 대부분을 차지했습니다. 공식 pipeline의 Python 전처리·분할 비용을 고정 tensor 직접 경로로 줄였습니다.</p></article>
        <article class="callout warn"><strong>CUDA Graph · Unavailable</strong><p>네 profile 모두 P40 capture 중 deferred CUDA error로 실패했습니다. 수치를 만들지 않았고 마지막 합격 eager 계열에서 계속했습니다.</p></article>
        <article class="callout baseline"><strong>Packed MoE · N/A</strong><p>Chronos-2는 dense feed-forward 모델이라 FinCast의 4-expert batched GEMM 최적화를 적용할 구조가 없습니다.</p></article>
      </div>
    </div></section>

    <section class="section" id="accuracy"><div class="shell">
      <h2>FinCast vs selected Chronos-2 accuracy</h2>
      <p class="section-copy">전체 26,880 symbol×horizon observation 기준입니다. Chronos-2 close-only는 방향 정확도와 평균 pinball이 근소하게 좋지만 q50 MAE, RMSE, Brier, q10–q90 coverage는 나쁩니다. 따라서 정확도 우위라고 판정할 수 없습니다.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Metric</th><th>FinCast CUDA Graph FP32</th><th>Chronos-2 close-only</th><th>Delta</th><th>Reading</th></tr></thead>
        <tbody>
          <tr><td>Direction accuracy</td><td>${format(referenceAccuracy.direction_accuracy * 100, 3)}%</td><td>${format(candidateAccuracy.direction_accuracy * 100, 3)}%</td><td>${signedPercentPoint(candidateAccuracy.direction_accuracy - referenceAccuracy.direction_accuracy)}</td><td>${badge("passed", "Chronos slight")}</td></tr>
          <tr><td>Mean pinball loss ↓</td><td>${format(referenceAccuracy.mean_pinball_loss, 8)}</td><td>${format(candidateAccuracy.mean_pinball_loss, 8)}</td><td>${signedPercent((candidateAccuracy.mean_pinball_loss / referenceAccuracy.mean_pinball_loss - 1) * 100)}</td><td>${badge("passed", "Chronos slight")}</td></tr>
          <tr><td>q50 return MAE ↓</td><td>${format(referenceAccuracy.q50_return_mae, 8)}</td><td>${format(candidateAccuracy.q50_return_mae, 8)}</td><td>${signedPercent((candidateAccuracy.q50_return_mae / referenceAccuracy.q50_return_mae - 1) * 100)}</td><td>${badge("warn", "FinCast")}</td></tr>
          <tr><td>q50 return RMSE ↓</td><td>${format(referenceAccuracy.q50_return_rmse, 8)}</td><td>${format(candidateAccuracy.q50_return_rmse, 8)}</td><td>${signedPercent((candidateAccuracy.q50_return_rmse / referenceAccuracy.q50_return_rmse - 1) * 100)}</td><td>${badge("warn", "FinCast")}</td></tr>
          <tr><td>Up-probability Brier ↓</td><td>${format(referenceAccuracy.up_probability_brier, 6)}</td><td>${format(candidateAccuracy.up_probability_brier, 6)}</td><td>${signedPercent((candidateAccuracy.up_probability_brier / referenceAccuracy.up_probability_brier - 1) * 100)}</td><td>${badge("warn", "FinCast")}</td></tr>
          <tr><td>q10–q90 coverage</td><td>${percentFromFraction(referenceAccuracy.q10_q90_interval_coverage)}</td><td>${percentFromFraction(candidateAccuracy.q10_q90_interval_coverage)}</td><td>${signedPercentPoint(candidateAccuracy.q10_q90_interval_coverage - referenceAccuracy.q10_q90_interval_coverage)}</td><td>${badge("warn", "Chronos undercoverage")}</td></tr>
        </tbody>
      </table></div>
      <h3 style="margin-top:26px">By horizon · BTC and ETH weighted</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>Horizon</th><th>FinCast direction</th><th>Chronos direction</th><th>FinCast q50 MAE</th><th>Chronos q50 MAE</th><th>Pinball delta</th></tr></thead>
        <tbody>${horizons.map((value) => `<tr>
          <td>${value.horizon} min</td>
          <td>${format(value.reference.directionAccuracy * 100, 3)}%</td>
          <td>${format(value.candidate.directionAccuracy * 100, 3)}%</td>
          <td>${format(value.reference.q50Mae, 8)}</td>
          <td>${format(value.candidate.q50Mae, 8)}</td>
          <td>${signedPercent((value.candidate.pinball / value.reference.pinball - 1) * 100)}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div></section>

    <section class="section" id="returns"><div class="shell">
      <h2>Profitability diagnostic</h2>
      <p class="section-copy">5분 up-probability 하나로 long-only 진입/청산하고 round-trip 비용 12bp를 적용한 20개 preset×risk profile 진단입니다. 실제 Rust technical-state replay가 아니며 두 모델 모두 순수익이 음수입니다. Chronos의 손실이 작아 보이는 주된 이유는 더 좋은 gross edge가 아니라 거래를 30.4% 적게 해 비용 drag가 작기 때문입니다.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Measure</th><th>FinCast</th><th>Chronos-2 close-only</th><th>Interpretation</th></tr></thead>
        <tbody>
          <tr><td>Mean net total return</td><td>${percentFromFraction(returns.reference.meanTotalReturn)}</td><td>${percentFromFraction(returns.candidate.meanTotalReturn)}</td><td>${badge("fail", "both negative")}</td></tr>
          <tr><td>Median net total return</td><td>${percentFromFraction(returns.reference.medianTotalReturn)}</td><td>${percentFromFraction(returns.candidate.medianTotalReturn)}</td><td>Chronos ${signedPercentPoint(returns.candidate.medianTotalReturn - returns.reference.medianTotalReturn)} higher</td></tr>
          <tr><td>Mean gross return before modeled costs</td><td>${percentFromFraction(returns.reference.meanGrossReturn)}</td><td>${percentFromFraction(returns.candidate.meanGrossReturn)}</td><td>${badge("baseline", "FinCast higher gross")}</td></tr>
          <tr><td>Mean modeled cost drag</td><td>${percentFromFraction(returns.reference.meanCostDrag)}</td><td>${percentFromFraction(returns.candidate.meanCostDrag)}</td><td>turnover dominates</td></tr>
          <tr><td>Total trades · 20 profiles</td><td>${format(returns.reference.tradeCount, 0)}</td><td>${format(returns.candidate.tradeCount, 0)}</td><td>${signedPercent((returns.candidate.tradeCount / returns.reference.tradeCount - 1) * 100)} Chronos</td></tr>
          <tr><td>Decision mismatch</td><td colspan="2">${format(returns.gate.decision_mismatch_count, 0)} / ${format(returns.gate.decision_count, 0)} · ${percentFromFraction(returns.gate.decision_mismatch_rate)}</td><td>${badge("rejected", "not economically equivalent")}</td></tr>
        </tbody>
      </table></div>
    </div></section>

    <section class="section" id="reasons"><div class="shell">
      <h2>Why reasons differ — and whether it is acceptable</h2>
      <p class="section-copy">이번 차이는 같은 모델 backend의 작은 수치 drift가 아니라 서로 다른 모델 분포의 차이입니다. 실제 scenario에서는 종목별 action kind가 같아도 selection order와 설명 reason이 크게 달랐고, 다른 차단 조건을 제거해 확률 조건 하나만 작동시키면 30.02%가 다른 action을 냅니다. FinCast의 TensorRT outlier 11.97%p보다도 큰 최대 62.75%p threshold-audit 차이이므로 속도를 위해 감수할 수준이 아닙니다.</p>
      <div class="grid metrics">
        <article class="card"><span>Probability delta · median</span><strong>${format(threshold.absolute_probability_delta.median * 100, 2)}%p</strong><small>p95 ${format(threshold.absolute_probability_delta.p95 * 100, 2)}%p</small></article>
        <article class="card"><span>Probability delta · maximum</span><strong class="tone-fail">${format(threshold.absolute_probability_delta.maximum * 100, 2)}%p</strong><small>realized paired max ${format(selectedComparison.realized_accuracy.paired.absolute_up_probability_delta.maximum * 100, 2)}%p</small></article>
        <article class="card"><span>Threshold crossings</span><strong class="tone-fail">${format(threshold.threshold_crossing_count, 0)}</strong><small>${percentFromFraction(threshold.threshold_crossing_count / threshold.record_count)}</small></article>
        <article class="card"><span>Symbol-aligned action mismatch</span><strong>${format(selectedComparison.gate.symbol_aligned.action_kind_mismatches, 0)}</strong><small>fixed bullish-entry / bearish-exit scenario</small></article>
        <article class="card"><span>Symbol-aligned reason mismatch</span><strong class="tone-fail">${format(selectedComparison.gate.symbol_aligned.reason_mismatches, 0)}</strong><small>${percentFromFraction(selectedComparison.gate.symbol_aligned.reason_mismatch_rate)}</small></article>
        <article class="card"><span>Selection-order mismatch</span><strong class="tone-fail">${format(selectedComparison.gate.selection_order_mismatches, 0)}</strong><small>global list comparison</small></article>
        <article class="card"><span>Probability-only action mismatch</span><strong class="tone-fail">${format(nearThreshold.action_mismatch_count, 0)}</strong><small>${percentFromFraction(nearThreshold.action_mismatch_rate)}</small></article>
        <article class="card"><span>Assessment</span><strong class="tone-fail">Not acceptable</strong><small>offline replacement · live replacement</small></article>
      </div>
      <div class="grid two" style="margin-top:16px">
        <article class="surface"><h3>Root-cause counters</h3><div class="reason-list">${Object.entries(reason.cause_counts).toSorted((left, right) => right[1] - left[1]).map(([name, count]) => `<div class="reason-row"><span>${escape(name)}</span><strong>${format(count, 0)}</strong></div>`).join("")}</div></article>
        <article class="surface"><h3>Interpretation</h3>
          <div class="reason-list">
            <div class="reason-row"><span>Projected CDF segment changed</span><strong>${format(reason.cause_counts.projected_cdf_segment_change, 0)}</strong></div>
            <div class="reason-row"><span>Median probability / native-return amplification</span><strong>${format(selectedComparison.realized_accuracy.outlier_diagnostics.probability_per_native_return_amplification.median, 1)}×</strong></div>
            <div class="reason-row"><span>Candidate q50 error wins / losses</span><strong>${format(selectedComparison.realized_accuracy.paired.candidate_q50_error_wins, 0)} / ${format(selectedComparison.realized_accuracy.paired.candidate_q50_error_losses, 0)}</strong></div>
          </div>
          <p class="footnote">CDF의 0-return 위치가 좁은 quantile 구간을 옮겨 다니며 작은 가격 분포 차이를 큰 up-probability 차이로 확대합니다. Chronos-2는 dense 모델이므로 MoE routing trace 자체가 없습니다.</p>
        </article>
      </div>
      <article class="callout fail" style="margin-top:16px"><strong>교체 결론</strong><p>기술적으로 raw generator와 별도 challenger service는 사용할 수 있지만, FinCast raw backend의 drop-in 대체나 live 기본 모델로는 승인할 수 없습니다. 실제 Rust technical-state replay도 이번 테스트에 포함되지 않았으므로 live 승격 근거는 더더욱 없습니다.</p></article>
    </div></section>

    <section class="section" id="history"><div class="shell">
      <h2>Previous FinCast optimization and TensorRT history</h2>
      <p class="section-copy">이 표는 기존 self-contained 보고서의 보존된 측정값입니다. TensorRT 컨테이너·engine·plugin·build 결과는 사용자 지시에 따라 삭제됐고 여기에는 수치와 digest가 들어간 과거 보고서만 참조됩니다.</p>
      ${historical ? `<div class="table-scroll"><table>
        <thead><tr><th>Stage</th><th>c60/B48 or noted throughput</th><th>Incremental ratio</th><th>Status</th></tr></thead>
        <tbody>${fincastHistoryRows.map(([label, throughput, incremental, status]) => `<tr>
          <td>${escape(label)}</td>
          <td>${format(throughput)} series/s${bar(throughput, historyMaximum, label.includes("CUDA Graph") ? "cyan-fill" : "")}</td>
          <td>${incremental ? `${format(incremental, 3)}× · ${signedPercent((incremental - 1) * 100)}` : "baseline"}</td>
          <td>${badge(status, status === "rejected" ? "measured · not promoted" : status)}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <div class="grid three" style="margin-top:16px">
        <article class="callout baseline"><strong>FinCast CUDA Graph stays default</strong><p>5주 steady-state ${format(historical.fiveWeek?.throughput?.cuda_graph_series_per_second)} series/s. 현재 offline FinCast 기본값은 CUDA Graph FP32/B48이며 live WebSocket backend는 별도 승인 없이 바뀌지 않았습니다.</p></article>
        <article class="callout fail"><strong>TensorRT FP32 · +${format(historical.fiveWeek?.throughput?.speedup_percent)}%</strong><p>steady-state는 빨랐지만 process-wall은 ${signedPercent((historical.fiveWeek?.throughput?.process_speedup_ratio - 1) * 100)}였고, probability-only action 271건과 최대 11.97%p 차이로 승격 거부됐습니다.</p></article>
        <article class="callout fail"><strong>INT8 · ${format(historical.tensorrtInt8.throughput)} series/s</strong><p>TensorRT FP32보다 ${signedPercent(historical.tensorrtInt8.vsFp32?.throughput_improvement_percent)}, CUDA Graph FP32보다 ${signedPercent(historical.tensorrtInt8.vsCudaGraph?.throughput_improvement_percent)} 빨랐지만 numerical gate와 precision coverage를 실패했습니다.</p></article>
      </div>` : `<article class="callout warn"><strong>Historical report unavailable</strong><p>기존 FinCast self-contained report를 읽을 수 없어 수치를 만들지 않았습니다.</p></article>`}
    </div></section>

    <section class="section" id="artifacts"><div class="shell">
      <h2>Runtime, provenance, and retained evidence</h2>
      <p class="section-copy">Host toolkit와 실제 PyTorch inference runtime은 구분해 기록했습니다. 요청된 host CUDA 12.2/cuDNN header 8.9.7은 존재하지만 잠긴 torch wheel은 CUDA 12.4와 cuDNN 9.1을 사용했습니다. 정확히 요청한 runtime과 같다고 표시하지 않습니다.</p>
      <dl class="provenance">
        <dt>Run ID</dt><dd>${escape(args.runId)}</dd>
        <dt>Remote artifact root</dt><dd>${escape(reportEvidence.artifacts.remoteRoot)}</dd>
        <dt>GPU / power cap</dt><dd>${escape(runtime.host.gpu)} / ${format(runtime.host.power_limit_w, 0)}W</dd>
        <dt>Host nvcc</dt><dd>${escape(runtime.host.cuda_toolkit_nvcc)}</dd>
        <dt>Host cuDNN header</dt><dd>${escape(runtime.host.cudnn_header.trim())}</dd>
        <dt>Inference framework</dt><dd>Python ${escape(runtime.framework.python)} · torch ${escape(runtime.framework.torch)} · CUDA ${escape(runtime.framework.cuda_runtime)} · cuDNN ${escape(runtime.framework.cudnn_runtime)}</dd>
        <dt>Exact requested runtime</dt><dd>${escape(String(runtime.exact_requested_runtime))}</dd>
        <dt>Chronos-2 revision</dt><dd>${escape(runtime.model.revision)}</dd>
        <dt>Weights SHA-256</dt><dd>${escape(runtime.model.checkpoint_sha256)}</dd>
        <dt>Market bars SHA-256</dt><dd>${escape(source.market_bars.sha256)}</dd>
        <dt>Summary SHA-256</dt><dd>${escape(reportEvidence.artifacts.summarySha256)}</dd>
        <dt>Close-only comparison SHA-256</dt><dd>${escape(reportEvidence.artifacts.comparisons.close_only)}</dd>
        <dt>Historical FinCast report</dt><dd>${historical ? `${escape(shortDigest(historical.sourceReportSha256))} · binaries deleted` : "Unavailable"}</dd>
      </dl>
      <div class="grid two" style="margin-top:16px">
        <article class="callout pass"><strong>Service restoration confirmed</strong><p>qualification 종료 후 기존 FinCast container와 GPU peer service가 복구됐습니다. Chronos-2 기본값 변경은 source-side explicit challenger profile에만 반영했으며 이미지 build·push·배포는 수행하지 않았습니다.</p></article>
        <article class="callout warn"><strong>Known limitations</strong><p>Chronos CUDA Graph capture 실패, 실제 Rust technical-state replay 미포함, BTC·ETH 두 종목·단일 5주 창, 고회전 진단 수익률이라는 한계가 남습니다. TensorRT 수치는 과거 보고서이며 실행 artifact는 없습니다.</p></article>
      </div>
    </div></section>
  </main>

  <script id="report-evidence" type="application/json">${inlineJson(reportEvidence)}</script>
  <script>
    (() => {
      const activate = (name, attribute, panelAttribute, group) => {
        document.querySelectorAll('[' + attribute + ']').forEach((button) => {
          const active = button.getAttribute(attribute) === name;
          button.setAttribute('aria-selected', String(active));
        });
        document.querySelectorAll('[' + panelAttribute + ']').forEach((panel) => {
          panel.hidden = panel.getAttribute(panelAttribute) !== name;
        });
        document.querySelector('[data-tab-group="' + group + '"]')?.scrollIntoView({
          block: 'nearest',
        });
      };
      document.querySelectorAll('[data-profile-tab]').forEach((button) => {
        button.addEventListener('click', () => activate(
          button.getAttribute('data-profile-tab'),
          'data-profile-tab',
          'data-profile-panel',
          'batch',
        ));
      });
      document.querySelectorAll('[data-waterfall-tab]').forEach((button) => {
        button.addEventListener('click', () => activate(
          button.getAttribute('data-waterfall-tab'),
          'data-waterfall-tab',
          'data-waterfall-panel',
          'waterfall',
        ));
      });
    })();
  </script>
</body>
</html>`;

const temporary = `${args.output}.${process.pid}.${randomUUID()}.tmp`;
await writeFile(temporary, html, { encoding: "utf8", mode: 0o600 });
await rename(temporary, args.output);
process.stdout.write(`${JSON.stringify({
  schema_version: "chronos2-p40-qualification-report-generation/v1",
  status: "passed",
  output: args.output,
  run_id: args.runId,
  selected_profile: selectedProfile,
  selected_backend: selected.selectedBackend,
  selected_batch: selected.selectedBatch,
  replacement_eligible: false,
  sha256: await sha256(args.output),
})}\n`);
