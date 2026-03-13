/**
 * Builds assets/icon.ico and assets/icon.png from renderer/assets/zano-logo.png
 * on a black background.
 * Run: node scripts/build-icon.js
 * Requires: npm install sharp to-ico
 */
const path = require("path");
const fs = require("fs");

const projectRoot = path.resolve(__dirname, "..");
const sourceLogoPath = path.join(projectRoot, "renderer", "assets", "zano-logo.png");
const iconPath = path.join(projectRoot, "assets", "icon.ico");
const pngIconPath = path.join(projectRoot, "assets", "icon.png");

async function main() {
  let sharp, toIco;
  try {
    sharp = require("sharp");
    toIco = require("to-ico");
  } catch (e) {
    console.error("Run: npm install --save-dev sharp to-ico");
    process.exit(1);
  }

  if (!fs.existsSync(sourceLogoPath)) {
    console.error("Missing renderer/assets/zano-logo.png");
    process.exit(1);
  }

  const size = 512;
  // Black background
  const black = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // Logo resized to fit inside size with padding
  const logo = sharp(sourceLogoPath)
    .resize(size - 32, size - 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  const [blackBg, logoBuf] = await Promise.all([black, logo]);

  const composed = await sharp(blackBg)
    .composite([{ input: logoBuf, left: 16, top: 16 }])
    .png()
    .toBuffer();

  // PNG at 512 for electron-builder (mac/linux)
  fs.writeFileSync(pngIconPath, composed);

  // ICO maxes at 256 — downscale for .ico entries
  const base = sharp(composed);
  const icoBuffers = [];
  for (const s of [256, 48, 32, 16]) {
    icoBuffers.push(await base.clone().resize(s, s).png().toBuffer());
  }

  const ico = await toIco(icoBuffers);
  fs.writeFileSync(iconPath, ico);
  console.log("Wrote", iconPath);
  console.log("Wrote", pngIconPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
