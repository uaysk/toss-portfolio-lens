import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  WORKER_PAYLOAD_SCHEMA_VERSION,
} from "./contracts.js";
import { RustComputeClient } from "./rust-client.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

describe("RustComputeClient", () => {
  it("keeps one length-prefixed socket and correlates FIFO responses", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rust-client-"));
    const socketPath = path.join(directory, "compute.sock");
    const projections: string[] = [];
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
            projection: "summary" | "full";
          };
          buffer = buffer.subarray(frameBytes + 4);
          projections.push(request.projection);
          const body = Buffer.from(JSON.stringify({
            schema_version: WORKER_PAYLOAD_SCHEMA_VERSION, engine_version: request.engine_version, run_id: request.run_id,
            job_kind: request.job_kind, status: "completed", summary: {}, result: request.payload.value,
            warnings: [], artifacts: [], data_revision: request.data_revision, request_hash: request.request_hash,
            projection: request.projection,
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
    const summary = await client.compute<number>(
      "backtest",
      { value: 3 },
      { projection: "summary" },
    );
    expect(summary.result).toBe(3);
    expect(projections).toEqual(["full", "full", "summary"]);
  });

  it("aborts an in-flight request by closing only its dedicated socket", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rust-client-abort-"));
    const socketPath = path.join(directory, "compute.sock");
    let slowRequestStarted!: () => void;
    const slowRequest = new Promise<void>((resolve) => { slowRequestStarted = resolve; });
    let slowPeerClosed!: () => void;
    const slowClosed = new Promise<void>((resolve) => { slowPeerClosed = resolve; });
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength < 4) return;
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
        if (request.payload.value === 1) {
          slowRequestStarted();
          socket.once("close", slowPeerClosed);
          return;
        }
        const body = Buffer.from(JSON.stringify({
          schema_version: WORKER_PAYLOAD_SCHEMA_VERSION, engine_version: request.engine_version, run_id: request.run_id,
          job_kind: request.job_kind, status: "completed", summary: {}, result: request.payload.value,
          warnings: [], artifacts: [], data_revision: request.data_revision, request_hash: request.request_hash,
          payload_hash: createHash("sha256").update(canonicalJson(request.payload)).digest("hex"),
        }));
        const response = Buffer.allocUnsafe(body.byteLength + 4);
        response.writeUInt32BE(body.byteLength, 0);
        body.copy(response, 4);
        socket.write(response);
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

    const controller = new AbortController();
    const cancellation = new Error("synthetic run cancellation");
    const cancelled = client.compute<number>("backtest", { value: 1 }, { signal: controller.signal });
    await slowRequest;
    const unrelated = client.compute<number>("backtest", { value: 2 });
    controller.abort(cancellation);

    await expect(cancelled).rejects.toBe(cancellation);
    await expect(unrelated).resolves.toMatchObject({ result: 2 });
    await slowClosed;
  });

  it("leases the actually free shared channel instead of queueing behind a slow peer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rust-client-lease-"));
    const socketPath = path.join(directory, "compute.sock");
    let connectionId = 0;
    const requestConnections = new Map<number, number>();
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowStarted!: () => void;
    const slowRequestStarted = new Promise<void>((resolve) => { slowStarted = resolve; });
    const server = net.createServer((socket) => {
      const currentConnection = ++connectionId;
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
          requestConnections.set(request.payload.value, currentConnection);
          const respond = () => {
            const body = Buffer.from(JSON.stringify({
              schema_version: WORKER_PAYLOAD_SCHEMA_VERSION, engine_version: request.engine_version, run_id: request.run_id,
              job_kind: request.job_kind, status: "completed", summary: {}, result: request.payload.value,
              warnings: [], artifacts: [], data_revision: request.data_revision, request_hash: request.request_hash,
              payload_hash: createHash("sha256").update(canonicalJson(request.payload)).digest("hex"),
            }));
            const response = Buffer.allocUnsafe(body.byteLength + 4);
            response.writeUInt32BE(body.byteLength, 0);
            body.copy(response, 4);
            socket.write(response);
          };
          if (request.payload.value === 1) {
            slowStarted();
            void slowReleased.then(respond);
          } else {
            respond();
          }
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
    const client = new RustComputeClient({ socketPath, poolSize: 2, timeoutMs: 1_000 });
    cleanup.push(() => client.close());

    const first = client.compute<number>("backtest", { value: 1 });
    await slowRequestStarted;
    await expect(client.compute<number>("backtest", { value: 2 })).resolves.toMatchObject({ result: 2 });
    await expect(client.compute<number>("backtest", { value: 3 })).resolves.toMatchObject({ result: 3 });

    expect(requestConnections.get(1)).not.toBe(requestConnections.get(3));
    expect(requestConnections.get(2)).toBe(requestConnections.get(3));
    releaseSlow();
    await expect(first).resolves.toMatchObject({ result: 1 });
  });

  it("creates a cancellable dedicated channel only after scheduler admission", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rust-client-admission-"));
    const socketPath = path.join(directory, "compute.sock");
    let connections = 0;
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowStarted!: () => void;
    const slowRequestStarted = new Promise<void>((resolve) => { slowStarted = resolve; });
    const server = net.createServer((socket) => {
      connections += 1;
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength < 4) return;
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
        const respond = () => {
          const body = Buffer.from(JSON.stringify({
            schema_version: WORKER_PAYLOAD_SCHEMA_VERSION, engine_version: request.engine_version, run_id: request.run_id,
            job_kind: request.job_kind, status: "completed", summary: {}, result: request.payload.value,
            warnings: [], artifacts: [], data_revision: request.data_revision, request_hash: request.request_hash,
            payload_hash: createHash("sha256").update(canonicalJson(request.payload)).digest("hex"),
          }));
          const response = Buffer.allocUnsafe(body.byteLength + 4);
          response.writeUInt32BE(body.byteLength, 0);
          body.copy(response, 4);
          socket.write(response);
        };
        if (request.payload.value === 1) {
          slowStarted();
          void slowReleased.then(respond);
        } else {
          respond();
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
    const client = new RustComputeClient({
      socketPath,
      poolSize: 1,
      timeoutMs: 1_000,
      maxQueued: 1,
      queueTimeoutMs: 1_000,
    });
    cleanup.push(() => client.close());

    const first = client.compute<number>("backtest", { value: 1 });
    await slowRequestStarted;
    const controller = new AbortController();
    const cancellable = client.compute<number>("backtest", { value: 2 }, {
      signal: controller.signal,
    });
    await Promise.resolve();

    expect(connections).toBe(1);
    expect(client.snapshot()).toMatchObject({ active: 1, queued: 1 });
    releaseSlow();
    await expect(first).resolves.toMatchObject({ result: 1 });
    await expect(cancellable).resolves.toMatchObject({ result: 2 });
    expect(connections).toBe(2);
  });

  it("destroys and rejects a UDS connection attempt when the client closes", async () => {
    const connectingSocket = new net.Socket();
    const createConnection = vi.spyOn(net, "createConnection")
      .mockImplementation(() => connectingSocket);
    cleanup.push(() => createConnection.mockRestore());
    const client = new RustComputeClient({
      socketPath: "/tmp/toss-portfolio-lens-never-connect.sock",
      poolSize: 1,
      timeoutMs: 60_000,
    });

    const pending = client.compute<number>("backtest", { value: 1 });
    await vi.waitFor(() => expect(createConnection).toHaveBeenCalledOnce());
    client.close();

    await expect(pending).rejects.toThrow("Rust compute client closed");
    expect(connectingSocket.destroyed).toBe(true);
  });
});
