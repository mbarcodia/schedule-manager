// One-off script: renders the app's calendar glyph (same mark used in the
// prototype's top bar) onto a rounded square background at PWA icon sizes.
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BG = "#161826";
const ACCENT = "#9184d9";

function svgIcon(size, { padding = 0.22, radius = 0.22 } = {}) {
  const r = size * radius;
  const glyphSize = size * (1 - padding * 2);
  const offset = size * padding;
  // Calendar glyph: rounded rect body + top tabs + header rule, same
  // proportions as the prototype's inline SVG brand mark.
  const glyph = `
    <g transform="translate(${offset} ${offset}) scale(${glyphSize / 256})">
      <rect x="32" y="48" width="192" height="168" rx="16" stroke="${ACCENT}" stroke-width="14" fill="none"/>
      <line x1="32" y1="96" x2="224" y2="96" stroke="${ACCENT}" stroke-width="14"/>
      <line x1="80" y1="24" x2="80" y2="64" stroke="${ACCENT}" stroke-width="14" stroke-linecap="round"/>
      <line x1="176" y1="24" x2="176" y2="64" stroke="${ACCENT}" stroke-width="14" stroke-linecap="round"/>
    </g>
  `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${r}" fill="${BG}"/>
    ${glyph}
  </svg>`;
}

const outDir = new URL("../public/icons/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const targets = [
  { name: "icon-192.png", size: 192, opts: {} },
  { name: "icon-512.png", size: 512, opts: {} },
  { name: "icon-maskable-512.png", size: 512, opts: { padding: 0.3, radius: 0 } },
  { name: "apple-touch-icon.png", size: 180, opts: { radius: 0 } }, // iOS rounds it itself
];

for (const t of targets) {
  const svg = svgIcon(t.size, t.opts);
  const outPath = fileURLToPath(new URL(t.name, outDir));
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log(`wrote ${t.name}`);
}
