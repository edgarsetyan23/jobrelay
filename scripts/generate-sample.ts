// Generates public/sample.jpg -- a small synthetic image so a visitor can
// try the demo without needing their own file handy. Run once with:
//   npx tsx scripts/generate-sample.ts
// The output is committed to the repo (it's a few KB), so this script does
// not need to run again unless you want to change the sample.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "public", "sample.jpg");

const WIDTH = 900;
const HEIGHT = 600;

const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f4ede1"/>
      <stop offset="100%" stop-color="#d9c9ab"/>
    </linearGradient>
    <linearGradient id="ticket" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#fffaf0"/>
      <stop offset="100%" stop-color="#f0e6d2"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  ${Array.from({ length: 6 })
    .map((_, i) => `<circle cx="${80 + i * 150}" cy="${90 + (i % 2) * 40}" r="${18 + (i % 3) * 6}" fill="#4f6f52" opacity="0.10"/>`)
    .join("\n")}
  <g transform="translate(${WIDTH / 2 - 260}, ${HEIGHT / 2 - 150})">
    <rect x="0" y="0" width="520" height="300" rx="14" fill="url(#ticket)" stroke="#4f6f52" stroke-width="3" stroke-dasharray="2 10"/>
    <circle cx="0" cy="150" r="16" fill="#f4ede1" stroke="#4f6f52" stroke-width="3"/>
    <circle cx="520" cy="150" r="16" fill="#f4ede1" stroke="#4f6f52" stroke-width="3"/>
    <text x="260" y="100" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="#2b2b2b">JobRelay Workshop</text>
    <text x="260" y="145" text-anchor="middle" font-family="'Courier New', monospace" font-size="18" fill="#6b6b6b">TICKET NO. 0001 &#8226; SAMPLE</text>
    <line x1="40" y1="180" x2="480" y2="180" stroke="#c9b98f" stroke-width="2"/>
    <text x="260" y="220" text-anchor="middle" font-family="Georgia, serif" font-size="16" fill="#4f6f52">Pull the plug. Watch it recover.</text>
    <text x="260" y="260" text-anchor="middle" font-family="'Courier New', monospace" font-size="13" fill="#8a8a8a">Try me &#8594;</text>
  </g>
</svg>`;

async function main(): Promise<void> {
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
  await writeFile(OUT_PATH, buffer);
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT_PATH} (${buffer.byteLength} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
