/**
 * Builds assets/icon.ico from assets/logo.png on a black background.
 * Run: node scripts/build-icon.js
 * Requires: npm install sharp to-ico
 */
const path = require("path");
const fs = require("fs");

const projectRoot = path.resolve(__dirname, "..");
const assetsDir = path.join(projectRoot, "assets");
const logoPath = path.join(assetsDir, "logo.png");
const iconPath = path.join(assetsDir, "icon.ico");

async function main() {
  let sharp, toIco;
  try {
    sharp = require("sharp");
    toIco = require("to-ico");
  } catch (e) {
    console.error("Run: npm install --save-dev sharp to-ico");
    process.exit(1);
  }

  if (!fs.existsSync(logoPath)) {
    console.error("Missing assets/logo.png");
    process.exit(1);
  }

  const size = 256;
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
  const logo = sharp(logoPath)
    .resize(size - 32, size - 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  const [blackBg, logoBuf] = await Promise.all([black, logo]);

  const composed = await sharp(blackBg)
    .composite([{ input: logoBuf, left: 16, top: 16 }])
    .png()
    .toBuffer();

  const buffers = [composed]; // 256
  const base = sharp(composed);
  for (const s of [48, 32, 16]) {
    buffers.push(await base.clone().resize(s, s).png().toBuffer());
  }

  const ico = await toIco(buffers);
  fs.writeFileSync(iconPath, ico);
  console.log("Wrote", iconPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
