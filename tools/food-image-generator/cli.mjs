#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FOODS_PATH = path.join(REPO_ROOT, "data", "foods.json");
const IMAGE_DIR = path.join(REPO_ROOT, "images", "foods");

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

async function main() {
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

main().catch((error) => {
  console.error("Food Image Generator failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
