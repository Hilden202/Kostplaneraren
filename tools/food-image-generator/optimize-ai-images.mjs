#!/usr/bin/env node

import { rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGET_WIDTH = 768;
const TARGET_HEIGHT = 512;
const WEBP_QUALITY = 80;

const AI_GENERATED_IMAGE_PATHS = [
  "images/foods/chokladboll.webp",
  "images/foods/fiskpudding-m-ris-hemlagad.webp",
  "images/foods/frukt-torkad.webp",
  "images/foods/graddfilssas-fett-9.webp",
  "images/foods/choklad-chokladpraliner.webp",
  "images/foods/choklad-ljus-vegansk.webp",
  "images/foods/chokladbiskvi-m-mandelbotten-smorkram-choklad.webp",
  "images/foods/chokladboll-hemlagad.webp",
  "images/foods/chokladdryck-drickf.webp",
  "images/foods/chokladdryck-m-vatten.webp",
  "images/foods/chokladdryckspulver-m-socker-fett-2-5.webp",
  "images/foods/chokladkaka-chocolate-chip-cookie-glutenfri.webp",
  "images/foods/chokladkex-m-vaniljfyllning.webp",
  "images/foods/chokladkola-mork-m-chokladoverdrag.webp",
  "images/foods/chokladmousse.webp",
  "images/foods/chokladmuffins-hembakad.webp",
  "images/foods/chokladpralin.webp",
  "images/foods/chokladpudding-m-vispad-gradde-fett-40.webp",
  "images/foods/chokladpudding.webp"
];

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function imageInfo(filePath) {
  const [metadata, stats] = await Promise.all([
    sharp(filePath).metadata(),
    stat(filePath)
  ]);

  return {
    width: metadata.width,
    height: metadata.height,
    bytes: stats.size
  };
}

async function optimizeImage(relativePath) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  const tempPath = path.join(
    path.dirname(absolutePath),
    `${path.basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const before = await imageInfo(absolutePath);

  try {
    await sharp(absolutePath)
      .resize({
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: WEBP_QUALITY })
      .toFile(tempPath);

    const after = await imageInfo(tempPath);

    if (after.width !== TARGET_WIDTH || after.height !== TARGET_HEIGHT) {
      throw new Error(`Expected ${TARGET_WIDTH}x${TARGET_HEIGHT}, got ${after.width}x${after.height}`);
    }

    await rename(tempPath, absolutePath);
    return { relativePath, before, after };
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

let beforeTotal = 0;
let afterTotal = 0;

console.log("Optimizing AI-generated food images");
console.log(`Images: ${AI_GENERATED_IMAGE_PATHS.length}`);
console.log(`Target: ${TARGET_WIDTH}x${TARGET_HEIGHT} WebP quality ${WEBP_QUALITY}`);
console.log("");

for (const relativePath of AI_GENERATED_IMAGE_PATHS) {
  const result = await optimizeImage(relativePath);
  beforeTotal += result.before.bytes;
  afterTotal += result.after.bytes;

  console.log(
    `${relativePath}: ${result.before.width}x${result.before.height} ${formatKiB(result.before.bytes)} -> `
    + `${result.after.width}x${result.after.height} ${formatKiB(result.after.bytes)}`
  );
}

const saved = beforeTotal - afterTotal;
const percent = beforeTotal > 0 ? (saved / beforeTotal) * 100 : 0;

console.log("");
console.log(`Before: ${formatKiB(beforeTotal)}`);
console.log(`After:  ${formatKiB(afterTotal)}`);
console.log(`Saved:  ${formatKiB(saved)} (${percent.toFixed(1)}%)`);
