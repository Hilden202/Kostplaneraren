#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, link, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FOODS_PATH = path.join(REPO_ROOT, "data", "foods.json");
const IMAGE_DIR = path.join(REPO_ROOT, "images", "foods");
const MANIFEST_SCRIPT_PATH = path.join(REPO_ROOT, "script", "generate-food-image-manifest.mjs");
const OPENAI_IMAGE_GENERATION_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_MODEL = "gpt-image-2";
const OPENAI_IMAGE_SIZE = "1536x1024";
const OPENAI_IMAGE_QUALITY = "high";
const OPENAI_IMAGE_FORMAT = "webp";
const MAX_BATCH_SIZE = 50;
const execFileAsync = promisify(execFile);

const BASE_IMAGE_PROMPT = `
Premium realistic food photography for a modern nutrition application.

The food must be immediately recognizable as the specified food and be the unmistakable primary subject of the image.

Present the food naturally and in a way that best communicates what it is. Adapt the presentation to the type of food:

- prepared dishes may naturally be shown in a bowl, pan or suitable serving dish
- sauces, soups and liquids may be shown in a suitable bowl, glass or container
- raw ingredients may be shown whole, sliced or prepared enough to make them clearly recognizable
- fruits and vegetables may include both whole and cut examples when useful
- dry ingredients may be shown in a simple bowl or natural arrangement
- packaged or commercial-style foods should primarily show the actual edible food rather than invented packaging

Realistic food photography.
Realistic proportions and realistic food texture.
Appetizing but believable appearance.
Food centered or clearly dominant in the composition.
Close enough framing that the food remains easy to identify when displayed as a relatively small image in a nutrition app.

Use soft professional food-photography lighting with pleasant depth and realistic highlights.

Prefer a dark, neutral, warm or naturally subdued background when appropriate, while allowing lighter backgrounds when they make the particular food clearer.

Use shallow to moderate depth of field.
Keep the main food sharply recognizable.

Natural contextual props are allowed when they help communicate the food, but keep them secondary and limited.
Examples include a spoon, pan, herbs, a few raw ingredients or another natural serving element.

Avoid excessive styling and clutter.

The image should feel like high-quality editorial food photography rather than advertising photography or a generic stock photo.

Do not impose a green halo, green circular glow or other recurring artificial lighting effect.

Do not invent product packaging, brands, logos, labels, nutritional information or readable packaging text.

No people.
No hands.
No UI elements.
No captions or text added to the image.

Landscape composition suitable for a food image/card in a nutrition application.

Prioritize in this order:

1. Correct visual representation of the specified food.
2. Immediate recognizability.
3. Realistic and appetizing appearance.
4. Pleasant photographic composition.
5. Consistency with a collection of high-quality food photography.
`.trim();

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }

  return "";
}

function parseFoodPayload(payload) {
  if (Array.isArray(payload)) return payload;

  return payload?.foods
    || payload?.livsmedel
    || payload?.items
    || [];
}

async function loadFoods() {
  const payload = JSON.parse(await readFile(FOODS_PATH, "utf8"));
  const records = parseFoodPayload(payload);

  return records
    .map((record, index) => {
      const source = record && typeof record === "object" ? record : { name: record };
      const name = firstText(
        source.name,
        source.Name,
        source.namn,
        source.Namn,
        source.livsmedelsnamn,
        source.Livsmedelsnamn
      );
      const explicitSlug = firstText(source.slug, source.Slug);
      const slug = normalizeSlug(explicitSlug || name);

      return {
        id: firstText(source.id, source.Id, source.nummer, source.Nummer, index + 1),
        name,
        slug
      };
    })
    .filter((food) => food.name && food.slug);
}

async function loadWebpImageSlugs() {
  const entries = await readdir(IMAGE_DIR, { withFileTypes: true });
  const imageSlugs = new Set();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== ".webp") continue;

    const basename = path.basename(entry.name, path.extname(entry.name));
    const slug = normalizeSlug(basename);

    if (slug) imageSlugs.add(slug);
  }

  return imageSlugs;
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function repoPath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function groupFoodsBySlug(foods) {
  const bySlug = new Map();

  for (const food of foods) {
    if (!bySlug.has(food.slug)) bySlug.set(food.slug, []);
    bySlug.get(food.slug).push(food);
  }

  return bySlug;
}

function pad(value, width) {
  return String(value).padEnd(width, " ");
}

function printFoodRows(foods) {
  console.log(`${pad("ID", 8)} | ${pad("Slug", 44)} | Name`);
  console.log(`${"-".repeat(8)} | ${"-".repeat(44)} | ${"-".repeat(40)}`);

  for (const food of foods) {
    console.log(`${pad(food.id, 8)} | ${pad(food.slug, 44)} | ${food.name}`);
  }
}

function printSlugClashes(slugClashes) {
  if (slugClashes.length === 0) {
    console.log("None");
    return;
  }

  for (const [slug, foods] of slugClashes) {
    console.log(`- ${slug}`);
    for (const food of foods) {
      console.log(`  ${food.id} | ${food.name}`);
    }
  }
}

function targetPathForSlug(slug) {
  return path.join(IMAGE_DIR, `${slug}.webp`);
}

function parseBatchCount(value) {
  if (!/^[1-9]\d*$/.test(String(value || ""))) {
    throw new Error(`batch kräver ett positivt heltal mellan 1 och ${MAX_BATCH_SIZE}`);
  }

  const count = Number(value);

  if (count > MAX_BATCH_SIZE) {
    throw new Error(`batch är begränsat till högst ${MAX_BATCH_SIZE} bilder i denna version`);
  }

  return count;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function safeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  const apiKey = process.env.OPENAI_API_KEY;

  if (apiKey) {
    message = message.split(apiKey).join("[redacted]");
  }

  return message;
}

async function buildMissingAssetQueue(limit = Infinity) {
  const foods = await loadFoods();
  const imageSlugs = await loadWebpImageSlugs();
  const foodsBySlug = groupFoodsBySlug(foods);
  const missingSlugEntries = Array.from(foodsBySlug.entries())
    .filter(([slug]) => !imageSlugs.has(slug));

  return {
    foods,
    imageSlugs,
    foodsBySlug,
    missingSlugEntries,
    queue: missingSlugEntries
      .slice(0, limit)
      .map(([slug, slugFoods]) => ({
        slug,
        food: slugFoods[0],
        foods: slugFoods,
        targetPath: targetPathForSlug(slug)
      }))
  };
}

function foodSpecificPrompt(food) {
  if (food.slug === "chokladboll") {
    return [
      "Food: Chokladboll",
      "A classic Swedish chokladboll: a round chocolate and oat confection traditionally coated in coconut flakes.",
      "The image may show one or several chokladbollar if that gives a more natural and clearer presentation."
    ].join("\n");
  }

  return `Food: ${food.name}`;
}

function buildImagePrompt(food) {
  return `${BASE_IMAGE_PROMPT}\n\n${foodSpecificPrompt(food)}`;
}

function isWebpBuffer(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

async function verifyWebpImageFile(filePath) {
  const buffer = await readFile(filePath);

  if (!isWebpBuffer(buffer)) {
    throw new Error(`${repoPath(filePath)} is not a WebP image`);
  }

  try {
    const { stdout } = await execFileAsync("sips", [
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      filePath
    ]);
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);

    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error("missing image dimensions");
    }
  } catch (error) {
    throw new Error(`Saved file is not a readable WebP image: ${error.message}`);
  }
}

function getApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY saknas i environment. Avbryter utan att anropa OpenAI API.");
  }

  return apiKey;
}

function extractOpenAIError(payload) {
  return payload?.error?.message
    || payload?.message
    || "Unknown OpenAI API error";
}

async function requestOpenAIImage({ prompt, apiKey }) {
  const response = await fetch(OPENAI_IMAGE_GENERATION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      output_format: OPENAI_IMAGE_FORMAT,
      background: "opaque"
    })
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`OpenAI Image API returned ${response.status}: ${extractOpenAIError(payload)}`);
  }

  const b64Json = payload?.data?.[0]?.b64_json;

  if (!b64Json) {
    throw new Error("OpenAI Image API response did not include image data");
  }

  const buffer = Buffer.from(b64Json, "base64");

  if (!isWebpBuffer(buffer)) {
    throw new Error("OpenAI Image API did not return WebP data even though output_format=webp was requested");
  }

  return buffer;
}

async function saveNewWebpImage(buffer, targetPath) {
  const tempPath = path.join(
    path.dirname(targetPath),
    `${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  let targetCreated = false;

  try {
    await writeFile(tempPath, buffer, { flag: "wx" });
    await verifyWebpImageFile(tempPath);
    await link(tempPath, targetPath);
    targetCreated = true;
    await verifyWebpImageFile(targetPath);
  } catch (error) {
    if (targetCreated) {
      await unlink(targetPath).catch(() => {});
    }

    if (error?.code === "EEXIST") {
      const existsError = new Error(`${repoPath(targetPath)} already exists. Avbryter utan att skriva över.`);
      existsError.code = "TARGET_EXISTS";
      throw existsError;
    }

    throw error;
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function generateAndSaveFoodImage({ food, targetPath, apiKey }) {
  const prompt = buildImagePrompt(food);
  const imageBuffer = await requestOpenAIImage({ prompt, apiKey });
  await saveNewWebpImage(imageBuffer, targetPath);
}

async function generateOneImage(slugArg) {
  const requestedSlug = normalizeSlug(slugArg);

  if (!requestedSlug) {
    throw new Error("Ange exakt en slug. Exempel: node tools/food-image-generator/cli.mjs generate chokladboll");
  }

  const foods = await loadFoods();
  const foodsBySlug = groupFoodsBySlug(foods);
  const slugFoods = foodsBySlug.get(requestedSlug);

  if (!slugFoods) {
    throw new Error(`Hittade inget livsmedel med sluggen "${requestedSlug}" i data/foods.json`);
  }

  const targetPath = targetPathForSlug(requestedSlug);

  if (await pathExists(targetPath)) {
    throw new Error(`${repoPath(targetPath)} finns redan. Avbryter utan att skriva över.`);
  }

  const food = slugFoods[0];
  const apiKey = getApiKey();

  console.log("Food Image Generator");
  console.log("Generate one image");
  console.log(`Food:        ${food.name}`);
  console.log(`ID:          ${food.id}`);
  console.log(`Slug:        ${food.slug}`);
  console.log(`Output:      ${repoPath(targetPath)}`);
  console.log(`Model:       ${OPENAI_IMAGE_MODEL}`);
  console.log(`Size:        ${OPENAI_IMAGE_SIZE}`);
  console.log(`Format:      ${OPENAI_IMAGE_FORMAT}`);

  if (slugFoods.length > 1) {
    console.log(`Shared slug: ${slugFoods.length} foods use this asset`);
  }

  console.log("");
  console.log("Requesting exactly one image from OpenAI Image API...");

  await generateAndSaveFoodImage({ food, targetPath, apiKey });

  console.log(`Saved:       ${repoPath(targetPath)}`);
  console.log("Verified:    readable WebP image");
}

async function updateImageManifest() {
  const { stdout, stderr } = await execFileAsync(process.execPath, [MANIFEST_SCRIPT_PATH], {
    cwd: REPO_ROOT
  });

  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

async function countRemainingMissingAssets() {
  const { missingSlugEntries } = await buildMissingAssetQueue();
  return missingSlugEntries.length;
}

async function runBatch(countArg) {
  const requested = parseBatchCount(countArg);
  const { queue, missingSlugEntries } = await buildMissingAssetQueue(requested);
  const apiKey = queue.length > 0 ? getApiKey() : null;
  const startedAt = Date.now();
  const failed = [];
  let succeeded = 0;
  let skipped = requested - queue.length;
  let manifestError = null;
  let manifestOutput = "";

  console.log("Food Image Generator");
  console.log("Batch generate");
  console.log(`Requested: ${requested}`);
  console.log(`Queued:    ${queue.length}`);
  console.log(`Missing:   ${missingSlugEntries.length}`);
  console.log("");

  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    const position = index + 1;
    const prefix = `[${position}/${queue.length}]`;

    try {
      if (await pathExists(item.targetPath)) {
        skipped++;
        console.log(`${prefix} Skipped existing: ${repoPath(item.targetPath)}`);
        continue;
      }

      console.log(`${prefix} Generating: ${item.food.name} (${item.slug})`);
      await generateAndSaveFoodImage({
        food: item.food,
        targetPath: item.targetPath,
        apiKey
      });
      succeeded++;
      console.log(`${prefix} Saved: ${repoPath(item.targetPath)}`);
    } catch (error) {
      if (error?.code === "TARGET_EXISTS") {
        skipped++;
        console.log(`${prefix} Skipped existing: ${repoPath(item.targetPath)}`);
        continue;
      }

      failed.push({ slug: item.slug, message: safeErrorMessage(error) });
      console.error(`${prefix} Failed: ${item.slug}`);
      console.error(`${prefix} Error: ${safeErrorMessage(error)}`);
    }
  }

  if (succeeded > 0) {
    try {
      manifestOutput = await updateImageManifest();
    } catch (error) {
      manifestError = safeErrorMessage(error);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const remaining = await countRemainingMissingAssets();
  const average = succeeded > 0 ? formatDuration(elapsedMs / succeeded) : "n/a";

  console.log("");
  console.log("Batch summary");
  console.log(`Requested: ${requested}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Remaining: ${remaining}`);
  console.log(`Elapsed: ${formatDuration(elapsedMs)}`);
  console.log(`Average per successful image: ${average}`);

  if (succeeded > 0 && !manifestError) {
    console.log("Manifest: updated");
    if (manifestOutput) console.log(manifestOutput);
  }

  if (manifestError) {
    console.error("Manifest: failed");
    console.error(manifestError);
  }

  if (failed.length > 0) {
    console.log("");
    console.log("Failed slugs:");
    for (const item of failed) {
      console.log(`- ${item.slug}: ${item.message}`);
    }
  }
}

async function printSummary() {
  const foods = await loadFoods();
  const imageSlugs = await loadWebpImageSlugs();
  const foodsBySlug = groupFoodsBySlug(foods);
  const slugClashes = Array.from(foodsBySlug.entries())
    .filter(([, slugFoods]) => slugFoods.length > 1)
    .sort(([slugA], [slugB]) => slugA.localeCompare(slugB, "sv"));
  const missingSlugEntries = Array.from(foodsBySlug.entries())
    .filter(([slug]) => !imageSlugs.has(slug));
  const completedSlugCount = foodsBySlug.size - missingSlugEntries.length;
  const nextMissingFoods = missingSlugEntries
    .slice(0, 10)
    .map(([, slugFoods]) => slugFoods[0]);

  console.log("Food Image Generator");
  console.log(`Foods:        ${foods.length}`);
  console.log(`Unique slugs: ${foodsBySlug.size}`);
  console.log(`Images:       ${imageSlugs.size}`);
  console.log(`Completed:    ${completedSlugCount}`);
  console.log(`Missing:      ${missingSlugEntries.length}`);
  console.log(`Slug clashes: ${slugClashes.length}`);
  console.log("");
  console.log("Next missing foods:");
  printFoodRows(nextMissingFoods);
  console.log("");
  console.log("Shared slugs:");
  printSlugClashes(slugClashes);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    await printSummary();
    return;
  }

  if (command === "generate") {
    if (args.length !== 1) {
      throw new Error("Usage: node tools/food-image-generator/cli.mjs generate <slug>");
    }

    await generateOneImage(args[0]);
    return;
  }

  if (command === "batch") {
    if (args.length !== 1) {
      throw new Error(`Usage: node tools/food-image-generator/cli.mjs batch <antal 1-${MAX_BATCH_SIZE}>`);
    }

    await runBatch(args[0]);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error("Food Image Generator failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
