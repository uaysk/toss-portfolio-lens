import { closeSync, constants, existsSync, mkdirSync, openSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";

process.umask(0o077);
const directory = resolve(process.env.MCP_OAUTH_SECRETS_DIR || "secrets");
const clientSecretPath = resolve(directory, "mcp-oauth-client-secret");
const signingKeyPath = resolve(directory, "mcp-oauth-signing-key");

if (existsSync(clientSecretPath) || existsSync(signingKeyPath)) {
  console.error("MCP OAuth secret 파일이 이미 있어 덮어쓰지 않았습니다.");
  process.exitCode = 1;
} else {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const clientSecret = randomBytes(48).toString("base64url");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  function writeExclusive(filePath, value) {
    const descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, value, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    chmodSync(filePath, 0o600);
  }

  const createdPaths = [];
  try {
    writeExclusive(clientSecretPath, `${clientSecret}\n`);
    createdPaths.push(clientSecretPath);
    writeExclusive(signingKeyPath, privateKey);
    createdPaths.push(signingKeyPath);
    console.info("MCP OAuth client secret과 RSA signing key 파일을 생성했습니다. 값은 출력하지 않았습니다.");
  } catch (error) {
    for (const filePath of createdPaths) {
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // A cleanup failure is reported without printing file contents.
      }
    }
    console.error("MCP OAuth secret 파일 생성에 실패해 이번 실행에서 생성한 파일을 정리했습니다.");
    process.exitCode = 1;
  }
}
