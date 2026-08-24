import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  registerApiAndSpaFallbacks,
  registerMcpFallback,
} from "./routes/fallback.js";

const directories: string[] = [];
const servers: Server[] = [];

async function rawRequest(
  url: string,
  input: { headers?: Record<string, string>; method?: string } = {},
): Promise<{ body: Buffer; headers: IncomingHttpHeaders; status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, input, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks),
        headers: response.headers,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function startFixture(production = true) {
  const clientDirectory = mkdtempSync(path.join(tmpdir(), "portfolio-static-"));
  directories.push(clientDirectory);
  mkdirSync(path.join(clientDirectory, "assets"));
  mkdirSync(path.join(clientDirectory, "reports"));
  mkdirSync(path.join(clientDirectory, ".vite"));

  const assetBody = Array.from(
    { length: 8_192 },
    (_, index) => String.fromCharCode(33 + (index % 90)),
  ).join("");
  writeFileSync(path.join(clientDirectory, "assets", "app-deadbeef.js"), assetBody);
  writeFileSync(path.join(clientDirectory, ".vite", "manifest.json"), JSON.stringify({
    "index.html": {
      file: "assets/app-deadbeef.js",
    },
  }));
  writeFileSync(path.join(clientDirectory, "runtime-config.json"), "{\"revision\":1}");
  writeFileSync(
    path.join(clientDirectory, "reports", "crypto-scalping-model-comparison.html"),
    "<!doctype html><title>comparison</title>",
  );
  writeFileSync(
    path.join(clientDirectory, "index.html"),
    "<!doctype html><main>portfolio-spa-fixture</main>",
  );

  const app = createApp({
    trustProxy: [],
    routeRegistrars: [
      (application) => registerMcpFallback(application, false),
      (application) => registerApiAndSpaFallbacks(application, {
        clientDirectory,
        production,
      }),
    ],
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server unavailable.");
  return {
    assetBody,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("production static delivery", () => {
  it("caches only Vite assets immutably and revalidates mutable documents", async () => {
    const { assetBody, baseUrl } = await startFixture();
    const asset = await fetch(`${baseUrl}/assets/app-deadbeef.js`, {
      headers: { "Accept-Encoding": "identity" },
    });

    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(asset.headers.get("accept-ranges")).toBe("bytes");
    const lastModified = asset.headers.get("last-modified");
    expect(lastModified).toBeTruthy();
    const etag = asset.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await asset.text()).toBe(assetBody);

    const compressedAsset = await fetch(`${baseUrl}/assets/app-deadbeef.js`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(compressedAsset.headers.get("content-encoding")).toBe("gzip");
    expect(compressedAsset.headers.get("vary")).toContain("Accept-Encoding");
    expect(compressedAsset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await compressedAsset.text()).toBe(assetBody);

    const notModified = await rawRequest(`${baseUrl}/assets/app-deadbeef.js`, {
      headers: {
        "Accept-Encoding": "identity",
        "If-None-Match": etag!,
      },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(notModified.body).toHaveLength(0);

    const notModifiedSince = await rawRequest(`${baseUrl}/assets/app-deadbeef.js`, {
      headers: {
        "Accept-Encoding": "identity",
        "If-Modified-Since": lastModified!,
      },
    });
    expect(notModifiedSince.status).toBe(304);
    expect(notModifiedSince.body).toHaveLength(0);

    const head = await rawRequest(`${baseUrl}/assets/app-deadbeef.js`, {
      headers: { "Accept-Encoding": "identity" },
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(assetBody)));
    expect(head.body).toHaveLength(0);

    const mutable = await fetch(`${baseUrl}/runtime-config.json`);
    expect(mutable.headers.get("cache-control")).toBe("no-cache");

    const report = await fetch(
      `${baseUrl}/reports/crypto-scalping-model-comparison.html`,
    );
    expect(report.headers.get("cache-control")).toBe("no-store, max-age=0");

    const html = await fetch(`${baseUrl}/portfolio/deep-link`, {
      headers: { "Accept-Encoding": "identity" },
    });
    expect(html.headers.get("cache-control")).toBe("no-cache");
    const htmlEtag = html.headers.get("etag");
    expect(htmlEtag).toBeTruthy();
    expect(await html.text()).toContain("portfolio-spa-fixture");

    const unchangedHtml = await rawRequest(`${baseUrl}/portfolio/deep-link`, {
      headers: {
        "Accept-Encoding": "identity",
        "If-None-Match": htmlEtag!,
      },
    });
    expect(unchangedHtml.status).toBe(304);
    expect(unchangedHtml.headers["cache-control"]).toBe("no-cache");
    expect(unchangedHtml.body).toHaveLength(0);
  });

  it("keeps development assets revalidation-safe", async () => {
    const { baseUrl } = await startFixture(false);
    const asset = await fetch(`${baseUrl}/assets/app-deadbeef.js`, {
      headers: { "Accept-Encoding": "identity" },
    });

    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("no-cache");
  });

  it("preserves byte-range semantics without compressing a partial response", async () => {
    const { assetBody, baseUrl } = await startFixture();
    const start = 512;
    const end = 2_559;
    const response = await fetch(`${baseUrl}/assets/app-deadbeef.js`, {
      headers: {
        "Accept-Encoding": "gzip",
        Range: `bytes=${start}-${end}`,
      },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe(
      `bytes ${start}-${end}/${Buffer.byteLength(assetBody)}`,
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(assetBody.slice(start, end + 1));
  });

  it("returns a real 404 for a missing bundle instead of the SPA HTML", async () => {
    const { baseUrl } = await startFixture();
    const response = await fetch(`${baseUrl}/assets/missing-deadbeef.js`);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("Static asset not found.");

    for (const pathName of ["/api/not-deployed-yet", "/mcp/not-deployed-yet"]) {
      const missingEndpoint = await fetch(`${baseUrl}${pathName}`);
      expect(missingEndpoint.status).toBe(404);
      expect(missingEndpoint.headers.get("cache-control")).toBe("no-store");
      expect(missingEndpoint.headers.get("content-type")).toContain("application/json");
    }
  });
});
