import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), "jsonplus-package-smoke-"));

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temporaryRoot], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [packMetadata] = JSON.parse(packOutput);
  assert.equal(typeof packMetadata?.filename, "string", "npm pack did not return a tarball");

  const consumerRoot = join(temporaryRoot, "consumer");
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );

  const tarballPath = join(temporaryRoot, packMetadata.filename);
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: consumerRoot,
    stdio: "inherit",
  });

  const installedEntry = join(
    consumerRoot,
    "node_modules",
    "@weluvabid",
    "jsonplus",
    "dist",
    "index.js",
  );
  const { decode, encode } = await import(pathToFileURL(installedEntry).href);

  const shared = { value: 42n };
  const source = {
    left: shared,
    right: shared,
  };
  source.self = source;

  const restored = decode(encode(source));
  assert.equal(restored.self, restored, "cyclic identity was not preserved");
  assert.equal(restored.left, restored.right, "shared identity was not preserved");
  assert.equal(restored.left.value, 42n, "BigInt was not preserved");

  const declarationPath = join(
    consumerRoot,
    "node_modules",
    "@weluvabid",
    "jsonplus",
    "dist",
    "index.d.ts",
  );
  await access(declarationPath);

  const typecheckFile = join(consumerRoot, "consumer.ts");
  writeFileSync(
    typecheckFile,
    [
      'import { decode, encode } from "@weluvabid/jsonplus";',
      "const encoded: string = encode({ value: 42n });",
      "const decoded: unknown = decode(encoded);",
      "void decoded;",
      "",
    ].join("\n"),
  );
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      typecheckFile,
    ],
    { cwd: consumerRoot, stdio: "inherit" },
  );

  console.log("Package smoke test passed: runtime import, graph round-trip, and declarations.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
