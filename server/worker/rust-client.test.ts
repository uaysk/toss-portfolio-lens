import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./contracts.js";
import { RustComputeClient } from "./rust-client.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

describe("RustComputeClient", () => {
  it("keeps one length-prefixed socket and correlates FIFO responses", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rust-client-"));
    const socketPath = path.join(directory, "compute.sock");
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.byteLength >= 4) {
          const frameBytes = buffer.readUInt32BE(0);
          if (buffer.byteLength < frameBytes + 4) return;
          const request = JSON.parse(buffer.subarray(4, frameBytes + 4).toString("utf8")) as {
            engine_version: string;
            run_id: string;
            job_kind: "backtest";
            data_revision: string;
            request_hash: string;
            payload: { value: number };
          };
          buffer = buffer.subarray(frameBytes + 4);
          const body = Buffer.from(JSON.stringify({
            schema_version: "1.0", engine_version: request.engine_version, run_id: request.run_id,
            job_kind: request.job_kind, status: "completed", summary: {}, result: request.payload.value,
            warnings: [], artifacts: [], data_revision: request.data_revision, request_hash: request.request_hash,
            payload_hash: createHash("sha256").update(canonicalJson(request.payload)).digest("hex"),
          }));
          const response = Buffer.allocUnsafe(body.byteLength + 4);
          response.writeUInt32BE(body.byteLength, 0);
          body.copy(response, 4);
          socket.write(response);
        }
      });
    });
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPERM") resolve(false);
        else reject(error);
      });
      server.listen(socketPath, () => resolve(true));
    });
    if (!listening) return;
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const client = new RustComputeClient({ socketPath, poolSize: 1, timeoutMs: 1_000 });
    cleanup.push(() => client.close());
    const [first, second] = await Promise.all([
      client.compute<number>("backtest", { value: 1 }),
      client.compute<number>("backtest", { value: 2 }),
    ]);
    expect(first.result).toBe(1);
    expect(second.result).toBe(2);
  });
});
