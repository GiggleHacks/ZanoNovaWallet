/**
 * Downloads the pinned Zano macOS DMG and stages the minimal Contents layout
 * needed by simplewallet/zanod into build/vendor/zano-macos/ for packaging.
 *
 * Run automatically before mac pack/dist, or manually:
 * node scripts/prepare-zano-macos.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

if (process.platform !== "darwin") {
  console.error("prepare-zano-macos.js must run on macOS (darwin).");
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const stagingDir = path.join(projectRoot, "build", "vendor", "zano-macos");
const MACOS_DMG_URL =
  "https://build.zano.org/builds/zano-macos-x64-release-v2.1.15.457[8621a68].dmg";

function runOrThrow(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${cmd} failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout || "";
}

function findFilesNamed(rootDir, targetNames, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(rootDir, e.name);
    if (e.isDirectory()) {
      findFilesNamed(full, targetNames, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (targetNames.has(e.name)) out.push(full);
  }
  return out;
}

function ensureExecutable(filePath) {
  const mode = fs.statSync(filePath).mode | 0o755;
  fs.chmodSync(filePath, mode);
}

function copyDirectoryRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    fs.copyFileSync(src, dest);
  }
}

function findMountedZanoVolume() {
  const volumesRoot = "/Volumes";
  let entries = [];
  try {
    entries = fs.readdirSync(volumesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const volumePath = path.join(volumesRoot, e.name);
    const matches = findFilesNamed(volumePath, new Set(["simplewallet", "zanod"]));
    const hasSimplewallet = matches.some((p) => path.basename(p) === "simplewallet");
    const hasZanod = matches.some((p) => path.basename(p) === "zanod");
    if (hasSimplewallet && hasZanod) return volumePath;
  }
  return null;
}

async function main() {
  const tempDir = path.join(os.tmpdir(), `zano-macos-prepare-${Date.now()}`);
  const dmgPath = path.join(tempDir, "zano.dmg");
  fs.mkdirSync(tempDir, { recursive: true });

  let mountPoint = null;
  let mountedByScript = false;
  try {
    mountPoint = findMountedZanoVolume();
    if (mountPoint) {
      console.log(`Using existing mounted Zano volume at ${mountPoint} (skipping download/mount).`);
    } else {
      console.log("Downloading Zano macOS DMG...");
      const res = await fetch(MACOS_DMG_URL, { redirect: "follow" });
      if (!res.ok) {
        console.error("Failed to download DMG:", res.status);
        process.exit(1);
      }
      fs.writeFileSync(dmgPath, Buffer.from(await res.arrayBuffer()));

      console.log("Mounting DMG...");
      const attachOut = runOrThrow("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly"]);
      const lines = attachOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        const cols = line.split(/\s+/);
        const last = cols[cols.length - 1];
        if (last && last.startsWith("/Volumes/")) mountPoint = last;
      }
      if (!mountPoint) {
        throw new Error(`Could not determine DMG mount point. Output: ${attachOut}`);
      }
      mountedByScript = true;
    }

    console.log("Searching mounted volume for simplewallet and zanod...");
    const matches = findFilesNamed(mountPoint, new Set(["simplewallet", "zanod"]));
    const simplewalletPath = matches.find((p) => path.basename(p) === "simplewallet");
    const zanodPath = matches.find((p) => path.basename(p) === "zanod");
    if (!simplewalletPath || !zanodPath) {
      throw new Error(
        `Required binaries not found in DMG (simplewallet: ${Boolean(simplewalletPath)}, zanod: ${Boolean(zanodPath)}).`
      );
    }

    const simplewalletContentsDir = path.dirname(path.dirname(simplewalletPath));
    const zanodContentsDir = path.dirname(path.dirname(zanodPath));
    if (simplewalletContentsDir !== zanodContentsDir) {
      throw new Error("simplewallet and zanod were not found under the same Contents directory.");
    }

    const sourceMacOsDir = path.join(simplewalletContentsDir, "MacOS");
    const sourceBoostDir = path.join(simplewalletContentsDir, "Frameworks", "boost_libs");
    if (!fs.existsSync(sourceBoostDir)) {
      throw new Error(`Required boost_libs directory not found at ${sourceBoostDir}`);
    }

    fs.rmSync(stagingDir, { recursive: true, force: true });
    const stagedMacOsDir = path.join(stagingDir, "Contents", "MacOS");
    const stagedBoostDir = path.join(stagingDir, "Contents", "Frameworks", "boost_libs");
    fs.mkdirSync(stagedMacOsDir, { recursive: true });

    for (const binaryName of ["simplewallet", "zanod"]) {
      const src = path.join(sourceMacOsDir, binaryName);
      const dest = path.join(stagedMacOsDir, binaryName);
      fs.copyFileSync(src, dest);
      ensureExecutable(dest);
      console.log("Staged", path.relative(stagingDir, dest));
    }

    copyDirectoryRecursive(sourceBoostDir, stagedBoostDir);
    const boostLibs = fs.readdirSync(stagedBoostDir).filter((name) => name.endsWith(".dylib"));
    for (const lib of boostLibs) {
      console.log("Staged", path.join("Contents", "Frameworks", "boost_libs", lib));
    }

    console.log(`Done. Staged ${boostLibs.length + 2} file(s) in build/vendor/zano-macos/.`);
  } finally {
    if (mountPoint && mountedByScript) {
      try {
        runOrThrow("hdiutil", ["detach", mountPoint]);
      } catch (e) {
        console.error("Warning: failed to detach DMG:", e.message);
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
