/**
 * Downloads the pinned Zano Windows build ZIP and stages simplewallet.exe plus
 * required .dll files into build/vendor/simplewallet-win/ for packaging.
 *
 * Run automatically before pack/dist, or manually:
 * node scripts/prepare-simplewallet.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const projectRoot = path.resolve(__dirname, "..");
const stagingDir = path.join(projectRoot, "build", "vendor", "simplewallet-win");
// Pinned Windows ZIP for reproducible builds. Bump intentionally when you want
// to ship a newer backend; see https://github.com/hyle-team/zano/releases
const WINDOWS_ZIP_URL =
  "https://build.zano.org/builds/zano-win-x64-release-v2.1.15.457[8621a68].zip";
// Source: signed hashes published in the official Zano release notes.
const WINDOWS_ZIP_SHA256 =
  "e3867efe1288c96dcaf573ad0a0c00ff1bdb4614fd9697a4252742dd775829a6";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function assertExpectedSha256(buf, expected, label) {
  const actual = sha256Hex(buf);
  if (actual !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch.\nExpected: ${expected}\nActual:   ${actual}\nRefusing to stage an unverified build.`
    );
  }
}

function findSimplewalletDir(dir, visited = new Set()) {
  if (visited.has(dir)) return null;
  visited.add(dir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === "simplewallet.exe") return dir;
    if (e.isDirectory()) {
      const found = findSimplewalletDir(full, visited);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  let AdmZip;
  try {
    AdmZip = require("adm-zip");
  } catch (e) {
    console.error("Run: npm install --save-dev adm-zip");
    process.exit(1);
  }

  console.log("Downloading Zano Windows ZIP…");
  const zipRes = await fetch(WINDOWS_ZIP_URL, { redirect: "follow" });
  if (!zipRes.ok) {
    console.error("Failed to download ZIP:", zipRes.status);
    process.exit(1);
  }
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  assertExpectedSha256(zipBuf, WINDOWS_ZIP_SHA256, path.basename(WINDOWS_ZIP_URL));
  const tempDir = path.join(os.tmpdir(), `zano-nova-prepare-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const zip = new AdmZip(zipBuf);
    zip.extractAllTo(tempDir, true);
    const simplewalletDir = findSimplewalletDir(tempDir);
    if (!simplewalletDir) {
      console.error("simplewallet.exe not found inside the downloaded ZIP.");
      process.exit(1);
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const entries = fs.readdirSync(simplewalletDir, { withFileTypes: true });
    let copied = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower === "simplewallet.exe" || lower.endsWith(".dll")) {
        const src = path.join(simplewalletDir, e.name);
        const dest = path.join(stagingDir, e.name);
        fs.copyFileSync(src, dest);
        console.log("Copied", e.name);
        copied++;
      }
    }
    if (copied === 0) {
      console.error("No simplewallet.exe or .dll files found in", simplewalletDir);
      process.exit(1);
    }
    const dllCount = fs.readdirSync(stagingDir).filter((n) => n.toLowerCase().endsWith(".dll")).length;
    if (dllCount === 0) {
      console.error("No .dll files in build/vendor/simplewallet-win/; portable build will fail.");
      process.exit(1);
    }
    console.log(
      "Done. Staged",
      copied,
      "file(s) in build/vendor/simplewallet-win/ (",
      dllCount,
      "DLLs)."
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
