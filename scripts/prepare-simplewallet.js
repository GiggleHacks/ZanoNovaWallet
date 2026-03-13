/**
 * Downloads the latest Zano Windows build ZIP, extracts simplewallet.exe and
 * all required .dll files into resources/, so the packaged app works without
 * user setup. Run automatically before `npm run dist`, or manually: node scripts/prepare-simplewallet.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const projectRoot = path.resolve(__dirname, "..");
const resourcesDir = path.join(projectRoot, "resources");
// Pinned Windows ZIP for reproducible builds. Bump intentionally when you want
// to ship a newer backend; see https://github.com/hyle-team/zano/releases
const WINDOWS_ZIP_URL =
  "https://build.zano.org/builds/zano-win-x64-release-v2.1.15.457[8621a68].zip";

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
    fs.mkdirSync(resourcesDir, { recursive: true });
    const entries = fs.readdirSync(simplewalletDir, { withFileTypes: true });
    let copied = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower === "simplewallet.exe" || lower.endsWith(".dll")) {
        const src = path.join(simplewalletDir, e.name);
        const dest = path.join(resourcesDir, e.name);
        fs.copyFileSync(src, dest);
        console.log("Copied", e.name);
        copied++;
      }
    }
    if (copied === 0) {
      console.error("No simplewallet.exe or .dll files found in", simplewalletDir);
      process.exit(1);
    }
    const dllCount = fs.readdirSync(resourcesDir).filter((n) => n.toLowerCase().endsWith(".dll")).length;
    if (dllCount === 0) {
      console.error("No .dll files in resources/ — portable will fail on other PCs. Aborting.");
      process.exit(1);
    }
    console.log("Done. Copied", copied, "file(s) to resources/ (", dllCount, "DLLs).");
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
