import { mkdir, writeFile } from "node:fs/promises";

const LMV_API_URL = "https://dataportal.livsmedelsverket.se/livsmedel/api/v1/livsmedel";
const OUTPUT_PATH = new URL("../data/foods.json", import.meta.url);
const CHECK_CONCURRENCY = 8;

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

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

async function fetchAllFoods() {
  const limit = 2500;
  let offset = 0;
  const foods = [];

  while (true) {
    const data = await fetchJson(`${LMV_API_URL}?offset=${offset}&limit=${limit}&sprak=1`);
    const batch = Array.isArray(data.livsmedel) ? data.livsmedel : [];

    foods.push(...batch);

    if (batch.length < limit) break;
    offset += limit;
  }

  return foods;
}

function extractGroup(classifications) {
  for (const item of classifications) {
    const directGroup = item.huvudgrupp ?? item.huvudGrupp ?? item.grupp ?? "";
    if (directGroup) return directGroup;

    const facet = `${item.fasettkod || ""} ${item.fasett || ""}`.toLowerCase();
    if (facet.startsWith("a") || facet.includes("livsmedelsgrupp")) {
      return item.namn || "";
    }
  }

  return "";
}

async function fetchGroup(foodNumber) {
  try {
    const classifications = await fetchJson(`${LMV_API_URL}/${foodNumber}/klassificeringar?sprak=1`);
    return extractGroup(Array.isArray(classifications) ? classifications : []);
  } catch (error) {
    return "";
  }
}

async function mapWithConcurrency(items, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, items.length) }, worker));
  return results;
}

const rawFoods = await fetchAllFoods();
const foods = await mapWithConcurrency(rawFoods, async (food) => {
  const name = String(food.namn || "").trim();

  return {
    name,
    slug: normalizeSlug(name),
    group: await fetchGroup(food.nummer)
  };
});

const payload = {
  source: "Livsmedelsverket Livsmedelsdatabas",
  generatedAt: new Date().toISOString(),
  foods: foods
    .filter((food) => food.name && food.slug)
    .sort((a, b) => a.name.localeCompare(b.name, "sv"))
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Wrote ${payload.foods.length} foods to ${OUTPUT_PATH.pathname}`);
