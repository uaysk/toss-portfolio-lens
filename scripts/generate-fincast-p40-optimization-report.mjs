import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const CADENCES = [15, 30, 60];
const BATCHES = [16, 24, 32, 48, 50];
const STAGES = [
  ["eager", "Worker-local + B48"],
  ["no_padding", "No padding"],
  ["batched_experts", "Packed experts"],
  ["cuda_graph", "CUDA Graph"],
];
const FIVE_WEEK_SECONDS = 5 * 7 * 24 * 60 * 60;

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("Invalid report arguments.");
    values.set(name, value);
  }
  const evidence = values.get("--evidence");
  const output = values.get("--output");
  const baseReport = values.get("--base-report");
  const threeWeek = values.get("--three-week");
  const fiveWeek = values.get("--five-week");
  const runId = values.get("--run-id") ?? "unavailable";
  if (!evidence || !output || !isAbsolute(evidence) || !isAbsolute(output)) {
    throw new Error("--evidence and --output must be absolute paths.");
  }
  if (resolve(evidence) !== evidence || resolve(output) !== output) {
    throw new Error("Report paths must be normalized.");
  }
  for (const [name, value] of [
    ["--base-report", baseReport],
    ["--three-week", threeWeek],
    ["--five-week", fiveWeek],
  ]) {
    if (value && (!isAbsolute(value) || resolve(value) !== value)) {
      throw new Error(`${name} must be an absolute normalized path.`);
    }
  }
  return { evidence, output, runId, baseReport, threeWeek, fiveWeek };
}

async function json(path) {
  const payload = await readFile(path);
  return JSON.parse(payload.toString("utf8"));
}

async function optionalJson(path) {
  try {
    return await json(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function loadQualificationEvidence(root) {
  if (!root) return undefined;
  const summaryPath = join(root, "qualification-summary.json");
  const policyPath = join(root, "policy-regression.json");
  const statePath = join(root, "state.json");
  return {
    summary: await json(summaryPath),
    policy: await json(policyPath),
    state: await json(statePath),
    digests: {
      summary: await digest(summaryPath),
      policy: await digest(policyPath),
      state: await digest(statePath),
    },
  };
}

async function loadEmbeddedReportEvidence(path) {
  if (!path) return undefined;
  const html = await readFile(path, "utf8");
  const match = html.match(
    /<script id="report-evidence" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error("base report does not contain embedded evidence.");
  const policyDigest = html.match(
    /<td>TensorRT FP32 48h policy gate<\/td><td class="mono">([a-f0-9]{64})<\/td>/,
  )?.[1];
  return {
    evidence: JSON.parse(match[1]),
    fileDigests: {
      policyTensorRt: policyDigest,
    },
  };
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

function percent(value, digits = 1) {
  return finite(value) === undefined ? "Unavailable" : `${format(value, digits)}%`;
}

function ratio(candidate, reference) {
  return finite(candidate) !== undefined && finite(reference) !== undefined && reference > 0
    ? candidate / reference
    : undefined;
}

function median(values) {
  const sorted = values
    .filter((value) => finite(value) !== undefined)
    .toSorted((left, right) => left - right);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function escape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusClass(status) {
  if (status === "passed" || status === "available") return "pass";
  if (status === "rejected" || status === "failed") return "fail";
  return "warn";
}

function badge(status, label = status) {
  return `<span class="badge ${statusClass(status)}">${escape(label ?? "Unavailable")}</span>`;
}

function telemetry(result) {
  const available = (result?.rounds ?? [])
    .map((round) => round.gpu_telemetry)
    .filter((item) => item?.status === "available");
  if (!available.length) return {};
  const average = (selector) => {
    const values = available.map(selector).filter((value) => finite(value) !== undefined);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  };
  const maximum = (selector) => {
    const values = available.map(selector).filter((value) => finite(value) !== undefined);
    return values.length ? Math.max(...values) : undefined;
  };
  return {
    gpuMean: average((item) => item.gpu_utilization_percent?.mean),
    gpuMax: maximum((item) => item.gpu_utilization_percent?.max),
    vramMax: maximum((item) => item.max_memory_used_bytes),
    powerMean: average((item) => item.power_watts?.mean),
    powerMax: maximum((item) => item.power_watts?.max),
    temperatureMean: average((item) => item.temperature_celsius?.mean),
    temperatureMax: maximum((item) => item.temperature_celsius?.max),
  };
}

function mib(bytes) {
  return finite(bytes) === undefined ? undefined : bytes / (1024 * 1024);
}

function shortDigest(value) {
  return typeof value === "string" && value.length >= 16
    ? `${value.slice(0, 12)}…${value.slice(-8)}`
    : "Unavailable";
}

function stageResult(results, cadence, backend) {
  return backend === "eager"
    ? results.batches[cadence].find((item) => item.batch_size === 48)
    : results.stages[backend][cadence];
}

function bar(value, maximum, tone = "") {
  if (finite(value) === undefined || !maximum) return `<span class="missing">Unavailable</span>`;
  const width = Math.max(2, value / maximum * 100);
  return `<span class="bar-track"><span class="chart-bar ${tone}" style="width:${width.toFixed(3)}%"></span></span>`;
}

function renderBatchPanel(cadence, candidates) {
  const maximum = Math.max(...candidates.map((item) => item.timing.series_per_second.median));
  const rows = candidates.map((item) => {
    const selected = item.batch_size === 48;
    const t = item.timing;
    return `<tr>
      <td><span class="mono">B${item.batch_size}</span>${selected ? badge("passed", "selected") : ""}</td>
      <td>${format(t.series_per_second.median)} series/s${bar(t.series_per_second.median, maximum, selected ? "pass-bar" : "")}</td>
      <td>${format(t.wall_ms.p50)} ms</td>
      <td>${format(t.wall_ms.p95)} ms</td>
      <td>${format(t.wall_ms.p99)} ms</td>
      <td>${badge(item.status)}</td>
    </tr>`;
  }).join("");
  return `<section class="cadence-panel" data-cadence-panel="${cadence}" ${cadence === 60 ? "" : "hidden"}>
    <div class="table-scroll"><table>
      <thead><tr><th>Batch</th><th>Median throughput</th><th>p50</th><th>p95</th><th>p99</th><th>Gate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function renderWaterfall(cadence, data, liveBaseline) {
  const localReference = data.batches[cadence].find((item) => item.batch_size === 16);
  const candidates = [];
  if (cadence === 60 && liveBaseline) {
    candidates.push({
      id: "live",
      label: "Live WebSocket B16",
      throughput: 16 / (liveBaseline.elapsed_ms.median / 1_000),
      status: "passed",
      note: "unchanged live contract",
      baseline: true,
    });
  }
  candidates.push({
    id: "local",
    label: "Worker-local eager B16",
    throughput: localReference.timing.series_per_second.median,
    status: data.compatibility[cadence].status,
    note: data.compatibility[cadence].exact_digest ? "compatibility digest exact" : "digest mismatch",
    baseline: cadence !== 60,
  });
  for (const [backend, label] of STAGES) {
    if (backend === "eager") {
      candidates.push({
        id: "batch",
        label,
        throughput: stageResult(data, cadence, backend).timing.series_per_second.median,
        status: stageResult(data, cadence, backend).status,
        note: "batch sweep winner B48",
      });
      continue;
    }
    const result = stageResult(data, cadence, backend);
    candidates.push({
      id: backend,
      label,
      throughput: result.timing.series_per_second.median,
      status: result.status,
      note: backend === "cuda_graph"
        ? `capture ${format(result.graph_capture_ms)} ms`
        : backend === "batched_experts" ? "8 → 2 expert GEMMs/layer" : "512 valid bars",
    });
  }
  if (
    cadence === 60
    && finite(data.tensorrtFp32?.latency?.series_per_second?.median) !== undefined
  ) {
    candidates.push({
      id: "tensorrt_fp32",
      label: "TensorRT FP32 raw integration",
      throughput: data.rawTensorRt?.timing?.series_per_second_median
        ?? data.tensorrtFp32.latency.series_per_second.median,
      status: data.policyTensorRt?.status ?? data.tensorrtFp32.status,
      note: "prediction gate passed · policy reason gate rejected",
    });
  }
  if (
    cadence === 60
    && finite(data.tensorrt?.latency?.series_per_second?.median) !== undefined
  ) {
    candidates.push({
      id: "tensorrt_int8",
      label: "TensorRT INT8 challenger",
      throughput: data.tensorrt.latency.series_per_second.median,
      status: data.tensorrt.status,
      note: "challenger only · no promotion",
    });
  }
  const reference = candidates[0].throughput;
  const maximum = Math.max(...candidates.map((item) => item.throughput));
  const items = candidates.map((item, index) => {
    const prior = candidates[index - 1]?.throughput;
    const incremental = prior ? ratio(item.throughput, prior) : 1;
    const cumulative = ratio(item.throughput, reference);
    return `<article class="waterfall-row">
      <div><strong>${escape(item.label)}</strong><small>${escape(item.note)}</small></div>
      <div>${bar(item.throughput, maximum, item.baseline ? "baseline-bar" : item.status === "passed" ? "pass-bar" : "fail-bar")}</div>
      <div class="metric-right"><strong>${format(item.throughput)}</strong><small>series/s</small></div>
      <div class="ratio-cell"><span>${index === 0 ? "baseline" : `${format(incremental, 3)}× step`}</span><span>${format(cumulative, 3)}× cumulative</span></div>
    </article>`;
  }).join("");
  return `<section class="cadence-panel" data-waterfall-panel="${cadence}" ${cadence === 60 ? "" : "hidden"}>${items}</section>`;
}

function renderAccuracyRows(data) {
  const rows = [];
  for (const cadence of CADENCES) {
    rows.push(`<tr>
      <td>Transport · ${cadence}s</td>
      <td>${badge(data.compatibility[cadence].status)}</td>
      <td>${data.compatibility[cadence].exact_digest ? "Exact" : "Mismatch"}</td>
      <td>Exact projected digest</td>
      <td>${shortDigest(data.compatibility[cadence].worker_local_projected_digest)}</td>
    </tr>`);
    for (const backend of ["no_padding", "batched_experts", "cuda_graph"]) {
      const result = data.stages[backend][cadence];
      const gate = result.accuracy_gate;
      rows.push(`<tr>
        <td>${escape(backend)} · ${cadence}s</td>
        <td>${badge(result.status)}</td>
        <td>${percent(gate.direction_match_rate * 100, 2)}</td>
        <td>${format(gate.q50_error_over_iqr.median * 100, 5)}% / ${format(gate.q50_error_over_iqr.p95 * 100, 5)}%</td>
        <td>${backend === "cuda_graph"
          ? result.cuda_graph_exact_backend_eager ? "Exact backend-eager" : "Mismatch"
          : shortDigest(gate.candidate_digest)}</td>
      </tr>`);
    }
  }
  if (data.tensorrt?.accuracy_gate) {
    const gate = data.tensorrt.accuracy_gate;
    rows.push(`<tr>
      <td>tensorrt_int8 · 60s</td>
      <td>${badge(data.tensorrt.status)}</td>
      <td>${percent(gate.direction_match_rate * 100, 2)}</td>
      <td>${format(gate.q50_error_over_iqr.median * 100, 5)}% / ${format(gate.q50_error_over_iqr.p95 * 100, 5)}%</td>
      <td>${data.tensorrt.repeat_output_digest?.stable
        ? shortDigest(data.tensorrt.repeat_output_digest.digest)
        : "Unstable / unavailable"}</td>
    </tr>`);
  }
  if (data.tensorrtFp32?.accuracy_gate) {
    const gate = data.tensorrtFp32.accuracy_gate;
    rows.push(`<tr>
      <td>tensorrt_fp32 · 60s</td>
      <td>${badge(data.tensorrtFp32.status)}</td>
      <td>${percent(gate.direction_match_rate * 100, 2)}</td>
      <td>${format(gate.q50_error_over_iqr.median * 100, 5)}% / ${format(gate.q50_error_over_iqr.p95 * 100, 5)}%</td>
      <td>${data.tensorrtFp32.repeat_output_digest?.stable
        ? shortDigest(data.tensorrtFp32.repeat_output_digest.digest)
        : "Unstable / unavailable"}</td>
    </tr>`);
  }
  if (data.policyTensorRt?.prediction_gate) {
    const gate = data.policyTensorRt.prediction_gate;
    rows.push(`<tr>
      <td>tensorrt_fp32 · 48h / 384 rows</td>
      <td>${badge(data.policyTensorRt.status)}</td>
      <td>${percent(gate.direction_match_rate * 100, 2)}</td>
      <td>${format(gate.q50_error_over_iqr.median * 100, 5)}% / ${format(gate.q50_error_over_iqr.p95 * 100, 5)}%</td>
      <td>Prediction passed · ${data.policyTensorRt.gate.reason_mismatches} policy reason mismatches</td>
    </tr>`);
  }
  return rows.join("");
}

function renderTelemetryRows(data) {
  return CADENCES.map((cadence) => {
    const result = data.stages.cuda_graph[cadence];
    const item = telemetry(result);
    return `<tr>
      <td>${cadence}s · CUDA Graph B48</td>
      <td>${percent(item.gpuMean)} / ${percent(item.gpuMax)}</td>
      <td>${format(mib(item.vramMax), 0)} MiB</td>
      <td>${format(mib(result.memory.minimum_nvml_free_bytes), 0)} MiB</td>
      <td>${format(item.powerMean, 1)} / ${format(item.powerMax, 1)} W</td>
      <td>${format(item.temperatureMean, 1)} / ${format(item.temperatureMax, 1)} °C</td>
    </tr>`;
  }).join("");
}

function renderAmortizationRows(data) {
  return CADENCES.map((cadence) => {
    const result = data.stages.cuda_graph[cadence];
    const rows = FIVE_WEEK_SECONDS / cadence;
    const steadySeconds = rows / result.timing.series_per_second.median;
    const captureSeconds = result.graph_capture_ms / 1_000;
    const amortized = steadySeconds + captureSeconds;
    return `<tr>
      <td>${cadence}s</td>
      <td>${format(rows, 0)}</td>
      <td>${format(result.graph_capture_ms, 2)} ms</td>
      <td>${format(steadySeconds, 2)} s</td>
      <td>${format(amortized, 2)} s</td>
      <td>${format(captureSeconds / steadySeconds * 100, 5)}%</td>
    </tr>`;
  }).join("");
}

function renderReasonMismatchRows(policy) {
  const rows = [];
  for (const sample of policy.gate.reason_mismatch_samples ?? []) {
    for (let index = 0; index < sample.reference_actions.length; index += 1) {
      const reference = sample.reference_actions[index];
      const candidate = sample.candidate_actions[index];
      if (JSON.stringify(reference?.reasons) === JSON.stringify(candidate?.reasons)) {
        continue;
      }
      rows.push(`<tr>
        <td class="mono">${escape(sample.origin_at)}</td>
        <td>${escape(sample.preset)} · risk ${format(sample.risk_tolerance, 0)}</td>
        <td>${escape(sample.scenario)} · ${escape(reference?.symbol ?? candidate?.symbol ?? "Unavailable")}</td>
        <td>${escape((reference?.reasons ?? ["Unavailable"]).join(", "))}</td>
        <td>${escape((candidate?.reasons ?? ["Unavailable"]).join(", "))}</td>
      </tr>`);
    }
  }
  return rows.length
    ? rows.join("")
    : `<tr><td colspan="5" class="missing">Unavailable</td></tr>`;
}

async function loadEvidence(root, embeddedFallback) {
  const resultsRoot = join(root, "results");
  const batches = {};
  for (const cadence of CADENCES) {
    batches[cadence] = [];
    for (const batch of BATCHES) {
      batches[cadence].push(await json(
        join(resultsRoot, `exclusive-eager-c${cadence}-b${batch}.json`),
      ));
    }
  }
  const stages = { no_padding: {}, batched_experts: {}, cuda_graph: {} };
  for (const backend of Object.keys(stages)) {
    for (const cadence of CADENCES) {
      stages[backend][cadence] = await json(
        join(resultsRoot, `${backend}-c${cadence}-b48.json`),
      );
    }
  }
  const compatibility = {};
  for (const cadence of CADENCES) {
    compatibility[cadence] = await json(
      join(resultsRoot, `compatibility-c${cadence}-b16.json`),
    );
  }
  const inputs = {};
  for (const cadence of CADENCES) {
    const path = join(root, "inputs", String(cadence), "manifest.json");
    inputs[cadence] = { value: await json(path), sha256: await digest(path) };
  }
  const paths = {
    policy: join(resultsRoot, "policy-regression.json"),
    tensorrt: join(resultsRoot, "tensorrt-int8-challenger.json"),
    tensorrtFp32: join(resultsRoot, "tensorrt-fp32-challenger.json"),
    raw: join(resultsRoot, "raw-smoke-c60-cuda_graph", "manifest.json"),
    policyTensorRt: join(
      resultsRoot,
      "policy-regression-tensorrt-fp32-integrated-v4.json",
    ),
  };
  const rawTensorRtRoot = join(
    resultsRoot,
    "policy-48h-tensorrt_fp32-integrated-v3",
  );
  const rawTensorRtManifestPath = join(rawTensorRtRoot, "manifest.json");
  const rawTensorRtManifest = await json(rawTensorRtManifestPath);
  const rawTensorRtChunks = await Promise.all(
    rawTensorRtManifest.chunks.map((name) => json(join(rawTensorRtRoot, name))),
  );
  const rawTensorRtWallMs = rawTensorRtChunks.reduce(
    (total, chunk) => total + chunk.latency.inference_wall_ms,
    0,
  );
  const rawTensorRt = {
    ...rawTensorRtManifest,
    chunk_metadata: rawTensorRtChunks,
    manifest_sha256: await digest(rawTensorRtManifestPath),
    timing: {
      series_per_second_median: median(
        rawTensorRtChunks.map((chunk) => chunk.latency.series_per_second),
      ),
      series_per_second_aggregate: rawTensorRtManifest.row_count
        / (rawTensorRtWallMs / 1_000),
    },
  };
  const rawTensorRtSmokeRoot = join(
    resultsRoot,
    "raw-smoke-c60-tensorrt_fp32-integrated-v3",
  );
  const rawTensorRtSmokeManifestPath = join(rawTensorRtSmokeRoot, "manifest.json");
  const rawTensorRtSmokeManifest = await json(rawTensorRtSmokeManifestPath);
  const rawTensorRtSmoke = {
    ...rawTensorRtSmokeManifest,
    chunk_metadata: await Promise.all(
      rawTensorRtSmokeManifest.chunks.map(
        (name) => json(join(rawTensorRtSmokeRoot, name)),
      ),
    ),
    manifest_sha256: await digest(rawTensorRtSmokeManifestPath),
  };
  const policyTensorRt = await optionalJson(paths.policyTensorRt)
    ?? embeddedFallback?.evidence?.policyTensorRt;
  if (!policyTensorRt) {
    throw new Error("TensorRT FP32 policy evidence is unavailable.");
  }
  const policyTensorRtDigest = await digest(paths.policyTensorRt)
    .catch((error) => {
      if (error?.code === "ENOENT") return embeddedFallback?.fileDigests?.policyTensorRt;
      throw error;
    });
  return {
    batches,
    stages,
    compatibility,
    inputs,
    policy: await json(paths.policy),
    tensorrt: await json(paths.tensorrt),
    tensorrtFp32: await json(paths.tensorrtFp32),
    policyTensorRt,
    raw: await json(paths.raw),
    rawTensorRt,
    rawTensorRtSmoke,
    validation: await optionalJson(join(resultsRoot, "validation-summary.json")),
    docker: await optionalJson(join(resultsRoot, "docker-smoke.json"))
      ?? await optionalJson(join(resultsRoot, "docker-build-smoke.json")),
    fileDigests: {
      policy: await digest(paths.policy),
      tensorrt: await digest(paths.tensorrt),
      tensorrtFp32: await digest(paths.tensorrtFp32),
      raw: await digest(paths.raw),
      policyTensorRt: policyTensorRtDigest,
      rawTensorRt: await digest(rawTensorRtManifestPath),
      rawTensorRtSmoke: await digest(rawTensorRtSmokeManifestPath),
    },
  };
}

function renderQualificationComparison(threeWeek, fiveWeek) {
  if (!fiveWeek) {
    return `<section class="report-section" id="five-week">
      <h2>5-week backend qualification</h2>
      <div class="surface"><span class="missing">Unavailable</span></div>
    </section>`;
  }
  const summary = fiveWeek.summary;
  const policy = fiveWeek.policy;
  const throughput = summary.throughput;
  const accuracy = policy.realized_accuracy;
  const paired = accuracy.paired;
  const outlierDiagnostics = accuracy.outlier_diagnostics;
  const returns = policy.model_signal_returns;
  const probabilityOnly = policy.probability_only_near_threshold;
  const aligned = policy.gate.symbol_aligned;
  const reasonAnalysis = policy.reason_difference_analysis;
  const topOutlier = accuracy.largest_probability_delta_samples?.[0];
  const previousSummary = threeWeek?.summary;
  const previousPolicy = threeWeek?.policy;
  const comparisonRows = [
    previousSummary && previousPolicy
      ? `<tr>
        <td>Previous · 3 weeks</td>
        <td>${format(previousSummary.configuration?.row_count, 0)}</td>
        <td>${format(previousSummary.throughput?.cuda_graph_series_per_second)} / ${format(previousSummary.throughput?.tensorrt_fp32_series_per_second)}</td>
        <td>${format(previousSummary.throughput?.speedup_ratio, 3)}×</td>
        <td>${percent(previousPolicy.prediction_gate?.direction_match_rate * 100, 4)}</td>
        <td>${format(previousPolicy.gate?.action_kind_mismatches, 0)} / ${format(previousPolicy.gate?.reason_mismatches, 0)}</td>
        <td><span class="missing">Unavailable in previous schema</span></td>
      </tr>`
      : `<tr><td>Previous · 3 weeks</td><td colspan="6" class="missing">Unavailable</td></tr>`,
    `<tr>
      <td>Current · 5 weeks</td>
      <td>${format(summary.configuration.row_count, 0)}</td>
      <td>${format(throughput.cuda_graph_series_per_second)} / ${format(throughput.tensorrt_fp32_series_per_second)}</td>
      <td>${format(throughput.speedup_ratio, 3)}×</td>
      <td>${percent(policy.prediction_gate.direction_match_rate * 100, 4)}</td>
      <td>${format(aligned.action_kind_mismatches, 0)} / ${format(aligned.reason_mismatches, 0)}</td>
      <td>${format(probabilityOnly.action_mismatch_count, 0)} / ${format(probabilityOnly.decision_count, 0)}</td>
    </tr>`,
  ].join("");
  const accuracyRows = Object.entries(accuracy.by_symbol_horizon ?? {})
    .map(([key, value]) => `<tr>
      <td>${escape(key)}</td>
      <td>${percent(value.reference.direction_accuracy * 100, 3)}</td>
      <td>${percent(value.candidate.direction_accuracy * 100, 3)}</td>
      <td>${format(value.reference.q50_return_mae * 10_000, 3)} / ${format(value.candidate.q50_return_mae * 10_000, 3)} bp</td>
      <td>${format(value.reference.up_probability_brier, 6)} / ${format(value.candidate.up_probability_brier, 6)}</td>
      <td>${percent(value.reference.q10_q90_interval_coverage * 100, 3)} / ${percent(value.candidate.q10_q90_interval_coverage * 100, 3)}</td>
    </tr>`).join("");
  const reasonKeys = new Set([
    ...Object.keys(reasonAnalysis.reason_code_deltas?.added_to_candidate ?? {}),
    ...Object.keys(reasonAnalysis.reason_code_deltas?.removed_from_candidate ?? {}),
  ]);
  const reasonRows = [...reasonKeys].sort().map((reason) => `<tr>
    <td><code>${escape(reason)}</code></td>
    <td>${format(reasonAnalysis.reason_code_deltas.added_to_candidate[reason] ?? 0, 0)}</td>
    <td>${format(reasonAnalysis.reason_code_deltas.removed_from_candidate[reason] ?? 0, 0)}</td>
  </tr>`).join("");
  const causeRows = Object.entries(reasonAnalysis.cause_counts ?? {})
    .map(([cause, count]) => `<tr><td><code>${escape(cause)}</code></td><td>${format(count, 0)}</td></tr>`)
    .join("");
  const crossingRows = Object.entries(probabilityOnly.mismatch_counts ?? {})
    .map(([boundary, count]) => `<tr><td><code>${escape(boundary)}</code></td><td>${format(count, 0)}</td></tr>`)
    .join("");
  const profileRows = (returns.profiles ?? []).map((profile) => `<tr>
    <td>${escape(profile.preset)} · ${format(profile.risk_tolerance, 0)}</td>
    <td>${percent(profile.reference.total_return * 100, 4)}</td>
    <td>${percent(profile.candidate.total_return * 100, 4)}</td>
    <td>${format(profile.delta.total_return * 10_000, 4)} bp</td>
    <td>${percent(profile.reference.maximum_drawdown * 100, 4)} / ${percent(profile.candidate.maximum_drawdown * 100, 4)}</td>
    <td>${format(profile.reference.trade_count, 0)} / ${format(profile.candidate.trade_count, 0)}</td>
  </tr>`).join("");
  const outlierRows = (accuracy.largest_probability_delta_samples ?? []).slice(0, 10)
    .map((sample) => `<tr>
      <td>${format(sample.row_id, 0)} · ${escape(sample.symbol)}</td>
      <td class="mono">${escape(sample.origin_at)}</td>
      <td>${format(sample.horizon_minutes, 0)}m</td>
      <td>${format(sample.delta.up_probability * 100, 4)} pp</td>
      <td>${format(sample.delta.q50_return * 10_000, 4)} bp</td>
      <td>${format(sample.actual_return * 10_000, 4)} bp</td>
      <td>${sample.reference.segment?.index ?? "—"} → ${sample.candidate.segment?.index ?? "—"}</td>
    </tr>`).join("");
  const returnGate = returns.gate;
  const outlierCounts = outlierDiagnostics.probability_delta_counts;
  return `<section class="report-section" id="five-week">
    <h2>5-week CUDA Graph FP32 vs TensorRT FP32</h2>
    <p class="section-copy">같은 6,720 rows, stateless routing, c60/B48에서 두 backend를 A/B 반복 실행했습니다. 아래 수익률은 실제 1분 OHLCV를 사용한 고정 5분 long-only 모델 신호 회귀이며 production 전체 정책 수익률을 뜻하지 않습니다.</p>
    <div class="grid metrics">
      <article class="metric-card"><span>Steady-state speedup</span><strong class="tone-pass">${format(throughput.speedup_ratio, 3)}×</strong><small>+${format(throughput.speedup_percent, 2)}% · ${format(throughput.cuda_graph_series_per_second)} → ${format(throughput.tensorrt_fp32_series_per_second)} series/s</small></article>
      <article class="metric-card"><span>Whole-process speedup</span><strong class="tone-fail">${format(throughput.process_speedup_ratio, 3)}×</strong><small>${format((throughput.process_speedup_ratio - 1) * 100, 2)}% · engine/model startup included</small></article>
      <article class="metric-card"><span>Probability-only action Δ</span><strong class="tone-fail">${format(probabilityOnly.action_mismatch_count, 0)}</strong><small>${percent(probabilityOnly.action_mismatch_rate * 100, 4)} of ${format(probabilityOnly.decision_count, 0)}</small></article>
      <article class="metric-card"><span>Maximum probability Δ</span><strong class="tone-fail">${format(paired.absolute_up_probability_delta.maximum * 100, 4)} pp</strong><small>≥1 / 5 / 10pp: ${format(outlierCounts.at_least_1pp, 0)} / ${format(outlierCounts.at_least_5pp, 0)} / ${format(outlierCounts.at_least_10pp, 0)}</small></article>
    </div>
    <div class="grid two" style="margin-top:14px">
      <article class="callout"><strong class="${returnGate.passed ? "tone-pass" : "tone-fail"}">Active probability-threshold economics: ${returnGate.passed ? "passed" : "rejected"}</strong><p>${format(returnGate.reference_trade_count, 0)} / ${format(returnGate.candidate_trade_count, 0)} Graph/TRT trades와 ${format(returnGate.decision_count, 0)} decisions에서 action 차이 ${format(returnGate.decision_mismatch_count, 0)}건이 발생했습니다. 최대 총수익률·MDD·equity curve Δ는 각각 ${format(returnGate.maximum_absolute_total_return_delta * 10_000, 4)} / ${format(returnGate.maximum_absolute_drawdown_delta * 10_000, 4)} / ${format(returnGate.maximum_absolute_equity_curve_delta * 10_000, 4)} bp입니다.</p></article>
      <article class="callout"><strong class="tone-fail">Live service replacement: not eligible</strong><p>symbol 정렬 action은 현재 합성 technical-state 시나리오에서 같았지만 reason ${format(aligned.reason_mismatches, 0)}건과 probability-only action ${format(probabilityOnly.action_mismatch_count, 0)}건이 달랐습니다. 실제 Rust technical-state replay와 per-layer routing trace도 아직 없습니다.</p></article>
    </div>
    <div class="surface table-scroll" style="margin-top:14px">
      <h3>Previous vs current evidence</h3>
      <table><thead><tr><th>Run</th><th>Rows</th><th>Graph / TRT series/s</th><th>Steady ratio</th><th>Prediction direction match</th><th>Aligned action / reason</th><th>Probability-only Δ</th></tr></thead><tbody>${comparisonRows}</tbody></table>
    </div>
    <div class="surface table-scroll" style="margin-top:14px">
      <h3>Realized forecast accuracy by symbol and horizon</h3>
      <table><thead><tr><th>Series</th><th>Graph direction</th><th>TRT direction</th><th>q50 MAE Graph / TRT</th><th>Brier Graph / TRT</th><th>q10–q90 coverage Graph / TRT</th></tr></thead><tbody>${accuracyRows}</tbody></table>
    </div>
    <div class="grid two" style="margin-top:14px">
      <article class="surface table-scroll"><h3>Reason boundary causes</h3><table><thead><tr><th>Cause</th><th>Rows</th></tr></thead><tbody>${causeRows}</tbody></table></article>
      <article class="surface table-scroll"><h3>Reason codes added / removed in TensorRT</h3><table><thead><tr><th>Reason</th><th>Added</th><th>Removed</th></tr></thead><tbody>${reasonRows}</tbody></table></article>
      <article class="surface table-scroll"><h3>Probability-only threshold crossings</h3><table><thead><tr><th>Boundary</th><th>Actions</th></tr></thead><tbody>${crossingRows}</tbody></table></article>
      <article class="callout"><strong class="tone-warn">Sparse discontinuity, routing root not yet proven</strong><p>${format(paired.count, 0)} realized observations 중 direction 차이는 ${format(paired.direction_disagreements, 0)}건입니다. p95 확률 Δ는 ${format(paired.absolute_up_probability_delta.p95 * 100, 6)}pp, p99는 ${format(paired.absolute_up_probability_delta.p99 * 100, 4)}pp인데 최대는 ${format(paired.absolute_up_probability_delta.maximum * 100, 4)}pp로 긴 꼬리입니다. 최종 engine은 router trace를 노출하지 않아 discrete MoE route divergence는 현재 관찰과 일치하는 추론이지 확정 원인이 아닙니다.</p></article>
    </div>
    <div class="surface table-scroll" style="margin-top:14px">
      <h3>Largest probability outliers</h3>
      <p class="section-copy">최대 사례 row ${format(topOutlier?.row_id, 0)}는 q50이 ${format(topOutlier?.delta?.q50_return * 10_000, 4)}bp 이동하고 CDF segment ${topOutlier?.reference?.segment?.index ?? "—"} → ${topOutlier?.candidate?.segment?.index ?? "—"}로 바뀌어 up-probability가 ${format(topOutlier?.delta?.up_probability * 100, 4)}pp 달라졌습니다.</p>
      <table><thead><tr><th>Row / symbol</th><th>Origin</th><th>Horizon</th><th>Probability Δ</th><th>q50 Δ</th><th>Actual return</th><th>CDF segment</th></tr></thead><tbody>${outlierRows}</tbody></table>
    </div>
    <div class="surface table-scroll" style="margin-top:14px">
      <h3>Fixed causal model-signal return profiles</h3>
      <table><thead><tr><th>Preset / risk</th><th>Graph return</th><th>TRT return</th><th>Return Δ</th><th>MDD Graph / TRT</th><th>Trades Graph / TRT</th></tr></thead><tbody>${profileRows}</tbody></table>
    </div>
  </section>`;
}

function reportHtml({ data, runId, liveBaseline }) {
  const final60 = data.stages.cuda_graph[60];
  const liveThroughput = liveBaseline
    ? 16 / (liveBaseline.elapsed_ms.median / 1_000)
    : undefined;
  const totalRatio = ratio(final60.timing.series_per_second.median, liveThroughput);
  const int8Throughput = data.tensorrt?.latency?.series_per_second?.median;
  const tensorrtFp32Throughput = data.tensorrtFp32?.latency?.series_per_second?.median;
  const integratedTensorRtThroughput = data.rawTensorRt.timing.series_per_second_median;
  const integratedTensorRtVsPytorch = ratio(
    integratedTensorRtThroughput,
    final60.timing.series_per_second.median,
  );
  const int8VsFp32 = ratio(int8Throughput, tensorrtFp32Throughput);
  const int8Improvement = finite(int8VsFp32) === undefined
    ? undefined
    : (int8VsFp32 - 1) * 100;
  const routerObservation = data.tensorrt?.routing_fp32_observation;
  const allFp32Passed = Object.values(data.stages)
    .flatMap((byCadence) => Object.values(byCadence))
    .every((item) => item.status === "passed");
  const validationStatus = data.validation?.status ?? "unavailable";
  const dockerStatus = data.docker?.status ?? "unavailable";
  const threeWeekQualification = data.qualifications?.threeWeek;
  const fiveWeekQualification = data.qualifications?.fiveWeek;
  const fiveWeekSummary = fiveWeekQualification?.summary;
  const fiveWeekPolicy = fiveWeekQualification?.policy;
  const generatedAt = new Date().toISOString();
  const evidenceJson = JSON.stringify({
    runId,
    generatedAt,
    batchSweep: data.batches,
    stages: data.stages,
    compatibility: data.compatibility,
    policy: data.policy,
    tensorrt: data.tensorrt,
    tensorrtFp32: data.tensorrtFp32,
    policyTensorRt: data.policyTensorRt,
    raw: data.raw,
    rawTensorRt: data.rawTensorRt,
    rawTensorRtSmoke: data.rawTensorRtSmoke,
    qualifications: data.qualifications ?? {
      threeWeek: { status: "unavailable" },
      fiveWeek: { status: "unavailable" },
    },
    validation: data.validation ?? { status: "unavailable" },
    docker: data.docker ?? { status: "unavailable" },
  }).replaceAll("<", "\\u003c");
  const batchPanels = CADENCES.map((cadence) => renderBatchPanel(cadence, data.batches[cadence])).join("");
  const waterfallPanels = CADENCES.map(
    (cadence) => renderWaterfall(cadence, data, liveBaseline),
  ).join("");
  const qualificationSection = renderQualificationComparison(
    threeWeekQualification,
    fiveWeekQualification,
  );
  const stageCards = CADENCES.map((cadence) => {
    const start = data.batches[cadence].find((item) => item.batch_size === 16);
    const final = data.stages.cuda_graph[cadence];
    const cumulative = ratio(
      final.timing.series_per_second.median,
      start.timing.series_per_second.median,
    );
    return `<article class="metric-card">
      <span>${cadence}s cadence</span>
      <strong>${format(final.timing.series_per_second.median)}</strong>
      <small>series/s · ${format(cumulative, 3)}× vs worker-local B16</small>
    </article>`;
  }).join("");
  const digestRows = [
    ...CADENCES.map((cadence) => [
      `Input ${cadence}s manifest`,
      data.inputs[cadence].sha256,
      data.batches[cadence][0].input.artifact_digest,
    ]),
    ["Fixed FP32 weights", final60.provenance.weights_sha256, final60.provenance.weights_file],
    ["FinCast source archive", final60.provenance.source_archive_sha256, final60.provenance.source_revision],
    ["Raw smoke manifest", data.fileDigests.raw, `${data.raw.backend} · B${data.raw.batch_size}`],
    [
      "Final FP32 smoke image",
      data.docker?.image?.id,
      data.docker?.smoke?.manifest_sha256,
    ],
    ["48h policy gate", data.fileDigests.policy, data.policy.candidate.output_digest],
    [
      "TensorRT FP32 48h policy gate",
      data.fileDigests.policyTensorRt,
      data.policyTensorRt.candidate.output_digest,
    ],
    [
      "TensorRT FP32 raw smoke manifest",
      data.fileDigests.rawTensorRtSmoke,
      `${data.rawTensorRtSmoke.backend} · B${data.rawTensorRtSmoke.batch_size}`,
    ],
    [
      "TensorRT strict FP32",
      data.fileDigests.tensorrtFp32,
      data.tensorrtFp32.engine.sha256,
    ],
    ["TensorRT challenger", data.fileDigests.tensorrt, data.tensorrt.calibration.split_digest],
    ...(threeWeekQualification ? [[
      "3-week qualification summary",
      threeWeekQualification.digests.summary,
      threeWeekQualification.digests.policy,
    ]] : []),
    ...(fiveWeekQualification ? [[
      "5-week qualification summary",
      fiveWeekQualification.digests.summary,
      fiveWeekQualification.digests.policy,
    ]] : []),
  ].map(([label, primary, secondary]) => `<tr>
    <td>${escape(label)}</td><td class="mono">${escape(primary ?? "Unavailable")}</td>
    <td class="mono">${escape(secondary ?? "Unavailable")}</td>
  </tr>`).join("");
  const unavailableReasons = (data.tensorrt.environment.reasons ?? [])
    .map((reason) => `<li><code>${escape(reason)}</code></li>`)
    .join("");
  const precisionTargets = data.tensorrt.precision_policy.int8_targets
    .map((target) => `<span class="token">${escape(target)}</span>`).join("");
  const fp32Allowlist = data.tensorrt.precision_policy.fp32_allowlist
    .map((target) => `<span class="token">${escape(target)}</span>`).join("");
  const policy = data.policy;
  const tensorRtPolicy = data.policyTensorRt;
  const rawTail = data.raw.chunks.at(-1);
  const tensorRtTail = data.rawTensorRtSmoke.chunk_metadata.at(-1);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none';">
  <title>FinCast P40 Optimization · ${escape(runId)}</title>
  <style>
    :root{color-scheme:dark;--background:0 0% 4%;--foreground:0 0% 96%;--card:0 0% 8%;--muted:0 0% 61%;--subtle:0 0% 14%;--pass:#34d399;--warn:#f59e0b;--fail:#fb7185;--baseline:#22d3ee}
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:hsl(var(--background))}
    body{margin:0;background:radial-gradient(circle at 78% -10%,#202020 0,transparent 34rem),hsl(var(--background));color:hsl(var(--foreground));font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-x:hidden}
    button,a{font:inherit}a{color:inherit;text-decoration:none}.shell{width:min(1180px,calc(100% - 32px));margin:auto}
    header{padding:72px 0 34px}.eyebrow{color:var(--baseline);font-size:12px;font-weight:750;letter-spacing:.13em;text-transform:uppercase}
    h1{margin:14px 0 10px;font-size:clamp(36px,7vw,72px);line-height:.98;letter-spacing:-.055em;max-width:900px}
    .lede{max-width:760px;color:#b6b6b6;font-size:16px}.badges,.tokens{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
    .badge,.token{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:#1b1b1b;color:#d7d7d7;font-size:11px;font-weight:720;letter-spacing:.02em}
    .badge.pass{color:var(--pass);background:#0e201a}.badge.warn{color:var(--warn);background:#271a07}.badge.fail{color:var(--fail);background:#281016}
    nav{position:sticky;top:0;z-index:5;background:rgba(10,10,10,.86);backdrop-filter:blur(16px);box-shadow:0 1px 0 rgba(255,255,255,.05)}
    nav .shell{display:flex;gap:18px;overflow:auto;padding:12px 0;color:#999;font-size:12px;white-space:nowrap}nav a:hover{color:#fff}
    main{padding:24px 0 80px}.grid{display:grid;gap:14px}.metrics{grid-template-columns:repeat(4,1fr)}
    .metric-card,.surface{background:hsl(var(--card));border-radius:14px;box-shadow:inset 0 1px rgba(255,255,255,.035),0 18px 50px rgba(0,0,0,.16)}
    .metric-card{padding:20px;min-height:128px}.metric-card span,.metric-card small{display:block;color:var(--muted)}
    .metric-card strong{display:block;margin:12px 0 4px;font-size:28px;letter-spacing:-.035em}
    section.report-section{padding-top:64px}h2{margin:0 0 8px;font-size:28px;letter-spacing:-.035em}h3{margin:0;font-size:16px}
    .section-copy{margin:0 0 20px;color:var(--muted);max-width:820px}.surface{padding:22px}
    .toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}.tabs{display:flex;gap:6px;background:#111;padding:4px;border-radius:10px}
    .tabs button{cursor:pointer;border:0;border-radius:7px;background:transparent;color:#777;padding:7px 11px}.tabs button[aria-pressed="true"]{background:#272727;color:#fff}
    [hidden]{display:none!important}.waterfall-row{display:grid;grid-template-columns:210px minmax(160px,1fr) 110px 180px;align-items:center;gap:14px;padding:11px 0}
    .waterfall-row+ .waterfall-row{box-shadow:inset 0 1px #171717}.waterfall-row small,.metric-right small{display:block;color:var(--muted)}
    .bar-track{display:block;height:10px;border-radius:999px;background:#151515;overflow:hidden}.chart-bar{display:block;height:100%;min-width:2px;border-radius:inherit;background:#777}
    .chart-bar.pass-bar{background:var(--pass)}.chart-bar.fail-bar{background:var(--fail)}.chart-bar.baseline-bar{background:var(--baseline)}
    .metric-right{text-align:right}.ratio-cell{display:flex;justify-content:flex-end;gap:10px;color:#a1a1a1;font-size:11px}.ratio-cell span:last-child{color:#eee}
    .table-scroll{max-width:100%;overflow:auto}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:12px 10px;vertical-align:top;box-shadow:inset 0 -1px #181818}
    th{color:#7d7d7d;font-size:11px;text-transform:uppercase;letter-spacing:.08em}td .badge{margin-left:8px}.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
    .table-scroll .bar-track{margin-top:6px;min-width:120px}.two{grid-template-columns:1.1fr .9fr}.callout{padding:20px;background:#111;border-radius:12px}
    .callout strong{font-size:22px}.callout p{color:var(--muted);margin:7px 0 0}.facts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
    .fact{padding:14px;border-radius:10px;background:#111}.fact span{display:block;color:#777;font-size:11px}.fact strong{display:block;margin-top:5px}
    ul.clean{margin:12px 0 0;padding-left:20px;color:#aaa}.token{border-radius:6px}.tone-pass{color:var(--pass)}.tone-warn{color:var(--warn)}.tone-fail{color:var(--fail)}.tone-baseline{color:var(--baseline)}
    footer{color:#666;padding:24px 0 50px;font-size:12px}.missing{color:var(--warn)}
    @media(max-width:840px){.metrics{grid-template-columns:repeat(2,1fr)}.two{grid-template-columns:1fr}.waterfall-row{grid-template-columns:1fr 110px}.waterfall-row>div:nth-child(2){grid-column:1/-1;grid-row:2}.ratio-cell{justify-content:flex-start}.metric-right{grid-column:2;grid-row:1;text-align:right}}
    @media(max-width:520px){.shell{width:min(100% - 22px,1180px)}header{padding:44px 0 24px}.metrics{grid-template-columns:1fr 1fr;gap:9px}.metric-card{padding:15px;min-height:112px}.metric-card strong{font-size:21px}.surface{padding:15px}.toolbar{align-items:flex-start;flex-direction:column}.facts{grid-template-columns:1fr}.waterfall-row{grid-template-columns:1fr 86px;gap:8px}.ratio-cell{grid-column:1/-1;justify-content:space-between}section.report-section{padding-top:48px}}
  </style>
</head>
<body>
  <nav><div class="shell"><a href="#outcome">Outcome</a><a href="#five-week">5-week</a><a href="#waterfall">Waterfall</a><a href="#batches">Batch sweep</a><a href="#gpu">GPU</a><a href="#accuracy">Accuracy</a><a href="#int8">INT8</a><a href="#artifacts">Artifacts</a></div></nav>
  <header class="shell" id="outcome">
    <div class="eyebrow">Tesla P40 · FP32 offline raw generation</div>
    <h1>FinCast inference,<br>measured end to end.</h1>
    <p class="lede">기존 live WebSocket 계약은 유지하고, OOS/raw prediction만 worker-local binary path로 분리했습니다. TensorRT FP32는 5주 steady-state에서 ${format(fiveWeekSummary?.throughput?.speedup_percent, 2)}% 빨랐지만 probability-only action ${format(fiveWeekPolicy?.probability_only_near_threshold?.action_mismatch_count, 0)}건과 최대 ${format(fiveWeekPolicy?.realized_accuracy?.paired?.absolute_up_probability_delta?.maximum * 100, 4)}pp 확률 차이가 남아 승격하지 않았습니다. INT8도 자동 승격하지 않았습니다.</p>
    <div class="badges">${badge(allFp32Passed ? "passed" : "failed", allFp32Passed ? "FP32 stages passed" : "FP32 gate failed")}${badge(fiveWeekSummary?.status ?? "unavailable", "5-week TensorRT qualification")}${badge(data.policy.status, "CUDA Graph 48h policy parity")}${badge(tensorRtPolicy.status, "TensorRT raw integration")}${badge(data.tensorrt.status, `INT8 ${data.tensorrt.status}`)}${badge(validationStatus, "source validation")}${badge(dockerStatus, "Docker smoke")}</div>
  </header>
  <main class="shell">
    <div class="grid metrics">
      <article class="metric-card"><span>Final offline backend</span><strong class="tone-pass">CUDA Graph</strong><small>B48 · all cadences</small></article>
      <article class="metric-card"><span>60s vs live WebSocket B16</span><strong>${format(totalRatio, 2)}×</strong><small>${finite(totalRatio) === undefined ? "Unavailable" : `+${format((totalRatio - 1) * 100, 1)}%`}</small></article>
      <article class="metric-card"><span>48h policy actions</span><strong>${format(policy.coverage.action_count, 0)}</strong><small>${policy.gate.action_kind_mismatches} mismatches</small></article>
      <article class="metric-card"><span>Integrated TensorRT FP32 vs PyTorch</span><strong class="tone-fail">${finite(integratedTensorRtVsPytorch) === undefined ? "Unavailable" : `${format(integratedTensorRtVsPytorch, 3)}×`}</strong><small>${finite(integratedTensorRtVsPytorch) === undefined ? "Unavailable" : `+${format((integratedTensorRtVsPytorch - 1) * 100, 2)}%`} · policy gate rejected</small></article>
      <article class="metric-card"><span>INT8 vs TensorRT FP32</span><strong class="tone-fail">${finite(int8VsFp32) === undefined ? "Unavailable" : `${format(int8VsFp32, 3)}×`}</strong><small>${finite(int8Improvement) === undefined ? "Unavailable" : `+${format(int8Improvement, 2)}%`} · accuracy rejected</small></article>
    </div>

    ${qualificationSection}

    <section class="report-section" id="waterfall">
      <div class="toolbar"><div><h2>Incremental & cumulative waterfall</h2><p class="section-copy">각 비율은 해당 candidate throughput을 직전 또는 기준 throughput으로 나눈 값입니다. 단계별 비율을 합산하지 않습니다.</p></div><div class="tabs" data-tabs="waterfall">${CADENCES.map((cadence) => `<button data-tab="${cadence}" aria-pressed="${cadence === 60}">${cadence}s</button>`).join("")}</div></div>
      <div class="surface">${waterfallPanels}</div>
    </section>

    <section class="report-section" id="batches">
      <div class="toolbar"><div><h2>Batch sweep</h2><p class="section-copy">독립 프로세스 · 3 rounds × 10 warmups + 30 timed iterations. 최종 exclusive sweep만 선택 근거로 사용했습니다.</p></div><div class="tabs" data-tabs="batch">${CADENCES.map((cadence) => `<button data-tab="${cadence}" aria-pressed="${cadence === 60}">${cadence}s</button>`).join("")}</div></div>
      <div class="surface">${batchPanels}</div>
    </section>

    <section class="report-section">
      <h2>Final cadence throughput</h2><p class="section-copy">Worker-local eager B16 대비 최종 CUDA Graph B48 누적 비율입니다.</p>
      <div class="grid metrics">${stageCards}</div>
    </section>

    <section class="report-section" id="gpu">
      <h2>GPU telemetry</h2><p class="section-copy">P40 power cap은 160W로 고정했습니다. 표는 final CUDA Graph timed rounds의 NVML 관찰값입니다.</p>
      <div class="surface table-scroll"><table><thead><tr><th>Candidate</th><th>GPU mean / max</th><th>VRAM max</th><th>Minimum free</th><th>Power mean / max</th><th>Temp mean / max</th></tr></thead><tbody>${renderTelemetryRows(data)}</tbody></table></div>
    </section>

    <section class="report-section" id="accuracy">
      <h2>Accuracy gate matrix</h2><p class="section-copy">고정 row-derived routing 아래 finite/monotonic/direction/q50-IQR gate를 적용했습니다. CUDA Graph는 같은 packed eager backend와 byte-exact입니다.</p>
      <div class="surface table-scroll"><table><thead><tr><th>Path</th><th>Status</th><th>Direction / exact</th><th>q50/IQR median · p95</th><th>Digest evidence</th></tr></thead><tbody>${renderAccuracyRows(data)}</tbody></table></div>
      <div class="grid two" style="margin-top:14px">
        <article class="callout"><span class="eyebrow">TensorRT FP32 · 48h BTC · ETH policy regression</span><strong class="tone-fail">${format(tensorRtPolicy.coverage.action_count, 0)} actions · ${tensorRtPolicy.gate.reason_mismatches} reason mismatches</strong><p>Selection order, action kind, target allocation은 모두 일치했지만 임계값 인접 BTC 사례에서 entry/exit 설명 reason 5건이 추가됐습니다. 현재 admission gate는 reason까지 exact이므로 rejected입니다.</p></article>
        <article class="facts">
          <div class="fact"><span>Prediction gate</span><strong class="tone-pass">${tensorRtPolicy.prediction_gate.passed ? "passed" : "rejected"}</strong></div>
          <div class="fact"><span>Direction agreement</span><strong>${percent(tensorRtPolicy.prediction_gate.direction_match_rate * 100, 3)}</strong></div>
          <div class="fact"><span>Action / allocation mismatch</span><strong>${tensorRtPolicy.gate.action_kind_mismatches} / ${format(tensorRtPolicy.gate.maximum_target_allocation_delta, 6)}</strong></div>
          <div class="fact"><span>Candidate digest</span><strong class="mono">${shortDigest(tensorRtPolicy.candidate.output_digest)}</strong></div>
        </article>
      </div>
      <div class="surface table-scroll" style="margin-top:14px">
        <h3>TensorRT policy reason differences · all observed cases</h3>
        <p class="section-copy">행동과 비중은 같지만 경계값 부근의 up-probability 판정이 달라 candidate reason에 한 항목이 추가된 5건입니다.</p>
        <table><thead><tr><th>Origin</th><th>Preset / risk</th><th>Scenario / symbol</th><th>CUDA Graph reference reasons</th><th>TensorRT FP32 reasons</th></tr></thead><tbody>${renderReasonMismatchRows(tensorRtPolicy)}</tbody></table>
      </div>
    </section>

    <section class="report-section">
      <h2>Build & capture amortization</h2><p class="section-copy">5주 연속 row 수에 steady-state throughput을 적용하고, 실제 graph capture 시간을 한 번 더했습니다. TensorRT FP32 build는 ${format(data.tensorrtFp32.build?.seconds, 2)}초, INT8 cached build는 ${format(data.tensorrt.build?.seconds, 2)}초이며 비교 artifact에만 반영됩니다.</p>
      <div class="surface table-scroll"><table><thead><tr><th>Cadence</th><th>5-week rows</th><th>Capture</th><th>Steady time</th><th>Amortized</th><th>Capture overhead</th></tr></thead><tbody>${renderAmortizationRows(data)}</tbody></table></div>
    </section>

    <section class="report-section" id="int8">
      <h2>TensorRT FP32 & INT8 comparison</h2><p class="section-copy">TensorRT 8.6.1.6 / Python 3.11 / CUDA 12.2 / cuDNN 8.9.7 / SM 6.1 격리 환경에서 같은 holdout과 측정 프로토콜로 비교했습니다. FP32는 TF32·FP16·INT8을 끄고 OBEY precision constraints를 적용했습니다. 자동 승격과 운영 배포는 금지했습니다.</p>
      <div class="grid metrics" style="margin-bottom:14px">
        <article class="metric-card"><span>PyTorch FP32 · c60/B48</span><strong class="tone-baseline">${format(final60.timing.series_per_second.median)}</strong><small>CUDA Graph · series/s</small></article>
        <article class="metric-card"><span>TensorRT FP32 · c60/B48</span><strong class="tone-pass">${format(tensorrtFp32Throughput)}</strong><small>series/s · accuracy passed</small></article>
        <article class="metric-card"><span>TensorRT INT8 · c60/B48</span><strong class="tone-fail">${format(int8Throughput)}</strong><small>series/s · accuracy rejected</small></article>
        <article class="metric-card"><span>INT8 / TensorRT FP32</span><strong>${format(int8VsFp32, 3)}×</strong><small>+${format(int8Improvement, 2)}% · rejected</small></article>
      </div>
      <div class="grid two">
        <article class="surface"><div class="toolbar"><h3>Environment probe</h3>${badge(data.tensorrt.status)}</div><div class="facts">
          <div class="fact"><span>Observed Python</span><strong>${escape(data.tensorrt.environment.observed.python ?? "Unavailable")}</strong></div>
          <div class="fact"><span>TensorRT</span><strong class="tone-warn">${escape(data.tensorrt.environment.observed.tensorrt ?? "Unavailable")}</strong></div>
          <div class="fact"><span>ONNX</span><strong class="tone-warn">${escape(data.tensorrt.environment.observed.onnx ?? "Unavailable")}</strong></div>
          <div class="fact"><span>Engine / latency</span><strong class="${data.tensorrt.engine ? "tone-pass" : "tone-warn"}">${data.tensorrt.engine ? `${format(data.tensorrt.engine.bytes / (1024 ** 3), 2)} GiB · ${format(int8Throughput)} series/s` : "Unavailable"}</strong></div>
          <div class="fact"><span>Calibration / holdout</span><strong>${data.tensorrt.calibration.calibration_rows} / ${data.tensorrt.calibration.holdout_rows}</strong></div>
          <div class="fact"><span>Retained / minimal evidence</span><strong>${format(data.tensorrt.storage?.final_retained_workspace_bytes / (1024 ** 3), 2)} / ${format(data.tensorrt.storage?.minimal_challenger_evidence_bytes / (1024 ** 3), 2)} GiB</strong></div>
          <div class="fact"><span>Cold / cached build</span><strong>${format(data.tensorrt.build?.cold_calibration_build_seconds, 2)} / ${format(data.tensorrt.build?.seconds, 2)} s</strong></div>
          <div class="fact"><span>Plugin SHA-256</span><strong class="mono">${shortDigest(data.tensorrt.environment.observed.plugin_source_sha256)}</strong></div>
        </div><ul class="clean">${unavailableReasons || "<li>No unavailable prerequisite.</li>"}</ul></article>
        <article class="surface"><h3>Precision intent & measured coverage</h3><p class="section-copy">Engine inspector 기준 INT8-touch layer ${format(data.tensorrt.precision_coverage?.int8_layer_count, 0)}, FP32 allowlist 위반 ${format(data.tensorrt.precision_coverage?.fp32_allowlist_violations, 0)}입니다. Weighted convolution ${format(data.tensorrt.precision_coverage?.weighted_convolution?.int8, 0)}/${format(data.tensorrt.precision_coverage?.weighted_convolution?.total, 0)}은 INT8이지만 attention QK/AV MatMul ${format(data.tensorrt.precision_coverage?.attention_runtime_matmul?.int8, 0)}/${format(data.tensorrt.precision_coverage?.attention_runtime_matmul?.total, 0)}과 packed expert Myelin ${format(data.tensorrt.precision_coverage?.packed_expert_myelin?.int8, 0)}/${format(data.tensorrt.precision_coverage?.packed_expert_myelin?.total, 0)}은 FP32 fallback입니다.</p><span>INT8 targets</span><div class="tokens">${precisionTargets}</div><span style="display:block;margin-top:18px">FP32 allowlist</span><div class="tokens">${fp32Allowlist}</div></article>
      </div>
      <div class="grid two" style="margin-top:14px">
        <article class="callout"><strong class="tone-pass">Strict FP32 validates the TensorRT path</strong><p>Direction ${percent(data.tensorrtFp32.accuracy_gate.direction_match_rate * 100, 2)}, q50/IQR median ${percent(data.tensorrtFp32.accuracy_gate.q50_error_over_iqr.median * 100, 5)}, p95 ${percent(data.tensorrtFp32.accuracy_gate.q50_error_over_iqr.p95 * 100, 5)}. Inspector INT8/Half layer는 ${data.tensorrtFp32.precision.inspector_int8_layer_count}/${data.tensorrtFp32.precision.inspector_fp16_layer_count}입니다. 따라서 ONNX lowering/plugin이 아니라 INT8 quantization이 정확도 실패 원인입니다.</p></article>
        <article class="callout"><strong class="tone-fail">Raw integration is functional, not admitted</strong><p>실제 raw-generate median은 ${format(integratedTensorRtThroughput)} series/s (${format(integratedTensorRtVsPytorch, 3)}× vs CUDA Graph benchmark)였고 full batch, 32-row tail, resume, 명시적 load fallback을 통과했습니다. 그러나 48시간 policy reason 5건이 달라 기본값 교체는 거부했습니다.</p></article>
        <article class="callout"><strong class="tone-fail">Fast, but numerically rejected</strong><p>Direction ${percent(data.tensorrt.accuracy_gate?.direction_match_rate * 100, 2)} (gate 99%), q50/IQR median ${percent(data.tensorrt.accuracy_gate?.q50_error_over_iqr?.median * 100, 2)} (gate 5%), p95 ${percent(data.tensorrt.accuracy_gate?.q50_error_over_iqr?.p95 * 100, 2)} (gate 15%). 처리량 이득은 승격 근거로 사용하지 않았습니다.</p></article>
        <article class="callout"><strong class="tone-warn">Routing remains FP32</strong><p>Allowlist를 제거한 비교 엔진에서도 inspector가 router projection 50/50을 FP32로 선택했습니다. 두 엔진 처리량 차이는 ${format(routerObservation?.canonical_vs_intent_throughput_change_percent, 3)}%였지만 실제 routing INT8 비교가 아니므로 성능 비용으로 해석하지 않습니다.</p></article>
        <article class="callout"><strong class="tone-warn">15s / 30s INT8 engines · Unavailable</strong><p>대표 c60 challenger가 정확도와 precision coverage admission을 실패했으므로 추가 cadence static engine을 만들지 않았습니다. 존재하지 않는 측정값은 추정하지 않습니다.</p></article>
      </div>
    </section>

    <section class="report-section">
      <h2>Raw generator integrity</h2><p class="section-copy">기본 CUDA Graph와 TensorRT FP32의 atomic chunks, resume prefix, static full batch, non-padded tail, 명시적 load fallback을 worker-1에서 smoke-tested 했습니다.</p>
      <div class="grid metrics">
        <article class="metric-card"><span>Schema</span><strong style="font-size:16px">${escape(data.raw.schema_version)}</strong><small>${data.raw.complete ? "complete" : "incomplete"}</small></article>
        <article class="metric-card"><span>Default</span><strong>${escape(data.raw.backend)} · B${data.raw.batch_size}</strong><small>offline only</small></article>
        <article class="metric-card"><span>Rows / chunks</span><strong>${data.raw.completed_rows} / ${data.raw.chunks.length}</strong><small>contiguous verified range</small></article>
        <article class="metric-card"><span>Tail</span><strong class="tone-pass">32 rows eager</strong><small>${escape(rawTail ?? "Unavailable")} · no padding</small></article>
        <article class="metric-card"><span>TensorRT full / tail</span><strong class="tone-fail">96 / 32 rows</strong><small>${escape(tensorRtTail?.latency?.execution_backend ?? "Unavailable")} tail · admission rejected</small></article>
      </div>
    </section>

    <section class="report-section" id="artifacts">
      <h2>Artifact digests & provenance</h2><p class="section-copy">고정 source/weights를 수정하지 않았습니다. 긴 SHA-256은 원문 그대로 HTML에 포함됩니다.</p>
      <div class="surface table-scroll"><table><thead><tr><th>Artifact</th><th>Primary SHA-256</th><th>Secondary provenance</th></tr></thead><tbody>${digestRows}</tbody></table></div>
    </section>

    <section class="report-section">
      <h2>Rejected & unavailable evidence</h2>
      <div class="grid two">
        <article class="callout"><strong class="tone-warn">Preliminary sweep excluded</strong><p>초기 eager 측정은 <code>llama-swap.service</code> GPU peer가 재기동되어 VRAM/latency가 오염됐습니다. 결과는 보존했지만 선택에는 exclusive-eager 파일만 사용했습니다.</p></article>
        <article class="callout"><strong class="tone-warn">CUDA verifier rerun</strong><p>첫 graph 측정은 capture warm-up 4회를 구조 gate가 1회로 잘못 가정해 rejected 됐습니다. 결과를 invalidated 디렉터리에 보존하고, 모든 관찰에서 <code>paddings=None</code>과 완전한 decode-call 배수를 강제한 뒤 재측정했습니다.</p></article>
        <article class="callout"><strong class="${data.tensorrt.status === "passed" ? "tone-pass" : "tone-fail"}">INT8 ${escape(data.tensorrt.status)}</strong><p>${data.tensorrt.status === "passed" ? "Engine build, inspector, holdout accuracy와 독점 P40 latency gate를 통과했지만 challenger로만 보존했습니다." : `Engine challenger는 ${escape((data.tensorrt.rejection_reasons ?? data.tensorrt.environment.reasons ?? ["unknown"]).join(", "))} 사유로 승격 거부됐습니다.`}</p></article>
        <article class="callout"><strong class="tone-warn">Strict FP32 first build rejected, then corrected</strong><p>첫 시도는 INT32 shape constant까지 FP32로 강제해 TensorRT validation이 거부했습니다. 실패 로그를 보존하고, floating execution output을 가진 레이어만 FP32로 제한해 다시 빌드했습니다.</p></article>
        <article class="callout"><strong class="tone-fail">Preliminary 48h TensorRT promotion rejected</strong><p>384-row prediction gate는 통과했지만 7,680 policy scenarios에서 reason 5건이 달랐습니다. 이 결과는 이후 3주·5주 검증의 출발점으로 보존했습니다.</p></article>
        <article class="callout"><strong class="tone-fail">5-week TensorRT service replacement rejected</strong><p>steady-state는 ${format(fiveWeekSummary?.throughput?.speedup_percent, 2)}% 빨랐지만 whole-process ratio는 ${format(fiveWeekSummary?.throughput?.process_speedup_ratio, 3)}×였고, probability-only action ${format(fiveWeekPolicy?.probability_only_near_threshold?.action_mismatch_count, 0)}건 및 최대 확률 Δ ${format(fiveWeekPolicy?.realized_accuracy?.paired?.absolute_up_probability_delta?.maximum * 100, 4)}pp가 남았습니다. offline raw 사용도 조건부일 뿐이며 실제 service backend는 교체하지 않습니다.</p></article>
        <article class="callout"><strong class="tone-baseline">Live backend unchanged</strong><p>TensorRT는 offline <code>raw-generate</code> backend로만 구현·검증했고 기본값 전환이나 live WebSocket 적용은 하지 않았습니다. Git push, PR, Harbor push, 배포, INT8 promotion도 수행하지 않았습니다.</p></article>
      </div>
    </section>
  </main>
  <footer class="shell">Run ${escape(runId)} · generated ${escape(generatedAt)} · self-contained HTML · no external requests</footer>
  <script id="report-evidence" type="application/json">${evidenceJson}</script>
  <script>
    "use strict";
    for (const group of document.querySelectorAll("[data-tabs]")) {
      group.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-tab]");
        if (!button) return;
        const cadence = button.dataset.tab;
        for (const peer of group.querySelectorAll("button")) {
          peer.setAttribute("aria-pressed", String(peer === button));
        }
        const attribute = group.dataset.tabs === "batch" ? "data-cadence-panel" : "data-waterfall-panel";
        for (const panel of document.querySelectorAll("[" + attribute + "]")) {
          panel.hidden = panel.getAttribute(attribute) !== cadence;
        }
      });
    }
  </script>
</body>
</html>`;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  await stat(arguments_.evidence);
  const embeddedFallback = await loadEmbeddedReportEvidence(arguments_.baseReport);
  const data = await loadEvidence(arguments_.evidence, embeddedFallback);
  data.qualifications = {
    threeWeek: await loadQualificationEvidence(arguments_.threeWeek),
    fiveWeek: await loadQualificationEvidence(arguments_.fiveWeek),
  };
  const liveBaseline = await optionalJson(
    join(
      process.cwd(),
      "docs/reports/ai-p40-qualification-p40-20260727-104435/benchmarks/fincast-batch-16.json",
    ),
  );
  const html = reportHtml({ data, runId: arguments_.runId, liveBaseline });
  const temporary = join(
    dirname(arguments_.output),
    `.${basename(arguments_.output)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, html, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, arguments_.output);
  process.stdout.write(`${JSON.stringify({
    schema_version: "fincast-p40-optimization-report-result/v1",
    output: arguments_.output,
    size_bytes: Buffer.byteLength(html),
    sha256: createHash("sha256").update(html).digest("hex"),
    final_backend: "cuda_graph",
    final_batch: 48,
  })}\n`);
}

await main();
