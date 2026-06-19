import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';

const sizes = [16, 48, 128];
const outDir = path.resolve('src/assets');

for (const size of sizes) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background: dark circle
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI);
  ctx.fillStyle = '#1a1a2e';
  ctx.fill();
  ctx.strokeStyle = '#FF3366';
  ctx.lineWidth = Math.max(1, size / 16);
  ctx.stroke();

  // Draw a stylized "air draw" swoosh
  ctx.strokeStyle = '#FF3366';
  ctx.lineWidth = Math.max(1.5, size / 10);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.28;

  ctx.moveTo(cx - r, cy + r * 0.3);
  ctx.quadraticCurveTo(cx - r * 0.3, cy - r, cx + r * 0.2, cy - r * 0.2);
  ctx.quadraticCurveTo(cx + r * 0.6, cy + r * 0.3, cx + r, cy - r * 0.5);
  ctx.stroke();

  // Small dot at the "finger tip"
  ctx.beginPath();
  ctx.arc(cx + r, cy - r * 0.5, Math.max(1, size / 12), 0, 2 * Math.PI);
  ctx.fillStyle = '#FF3366';
  ctx.fill();

  // Save as PNG
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buffer);
  console.log(`Generated icon${size}.png`);
}
