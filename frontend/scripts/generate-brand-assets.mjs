// Regenerates the web assets, or a macOS icon when passed --mac-icon <output>.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '../src');
const brandDir = resolve(srcDir, 'assets/brand');

const source = resolve(brandDir, 'logo.svg');
const logo = await sharp(await readFile(source), { density: 192 }).trim().png().toBuffer();
const ink = '#1b2330';
const transparent = '#00000000';

function mark(width) {
  return sharp(logo).resize({ width }).png().toBuffer();
}

async function webAssets() {
  await copyFile(source, join(srcDir, 'favicon.svg'));
  const faviconImages = [];
  for (const size of [16, 32, 48]) {
    const image = await sharp(logo).resize(size, size, { fit: 'contain', background: transparent }).png().toBuffer();
    if (size !== 48) await writeFile(join(brandDir, `favicon-${size}.png`), image);
    faviconImages.push(image);
  }
  await writeFile(join(srcDir, 'favicon.ico'), await pngToIco(faviconImages));

  for (const [filename, size] of [
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
  ]) {
    // The mark fits inside the centered safe area for maskable icons.
    const input = await mark(Math.round(size * 0.67));
    await sharp({ create: { width: size, height: size, channels: 4, background: ink } })
      .composite([{ input }]).png().toFile(join(brandDir, filename));
  }

  await sharp({ create: { width: 1200, height: 630, channels: 4, background: ink } })
    .composite([{ input: await mark(480) }]).png().toFile(join(brandDir, 'og-image.png'));
  console.log('Updated web icons and social image from logo.svg');
}

async function macIcon(output) {
  const directory = await mkdtemp(join(tmpdir(), 'simulator-icon-'));
  try {
    const iconset = join(directory, 'App.iconset');
    await mkdir(iconset);
    const iconSizes = [16, 32, 128, 256, 512];
    const pixelSizes = new Set([...iconSizes, ...iconSizes.map((size) => size * 2)]);
    for (const size of pixelSizes) {
      const tile = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024"><rect x="72" y="72" width="880" height="880" rx="196" fill="${ink}"/></svg>`);
      const image = await sharp(tile).composite([{ input: await mark(Math.round(size * 0.68)) }]).png().toBuffer();
      if (iconSizes.includes(size)) await writeFile(join(iconset, `icon_${size}x${size}.png`), image);
      const halfSize = size / 2;
      if (iconSizes.includes(halfSize)) await writeFile(join(iconset, `icon_${halfSize}x${halfSize}@2x.png`), image);
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', output, iconset], { stdio: 'inherit' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const [, , option, output] = process.argv;
if (option === '--mac-icon' && output) {
  await macIcon(resolve(output));
} else if (!option) {
  await webAssets();
} else {
  throw new Error('Usage: node scripts/generate-brand-assets.mjs [--mac-icon <output>]');
}
