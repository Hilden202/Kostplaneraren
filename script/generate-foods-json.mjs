import { setDefaultResultOrder } from "node:dns";
import { mkdir, writeFile } from "node:fs/promises";

const LMV_API_URL = "https://dataportal.livsmedelsverket.se/livsmedel/api/v1/livsmedel";
const OUTPUT_PATH = new URL("../data/foods.json", import.meta.url);
const CHECK_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 45_000;
const FETCH_RETRIES = 2;
const MIN_EXPECTED_FOODS = 2400;

setDefaultResultOrder("ipv4first");

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

async function fetchJson(url, attempt = 0) {
  let response;

  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    response = await fetch(url, { signal });
  } catch (error) {
    if (attempt < FETCH_RETRIES) {
      return fetchJson(url, attempt + 1);
    }

    throw error;
  }

  if (!response.ok) {
    if (response.status >= 500 && attempt < FETCH_RETRIES) {
      return fetchJson(url, attempt + 1);
    }

    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

async function fetchAllFoods() {
  const limit = 2500;
  let offset = 0;
  const foods = [];
  let totalRecords = null;

  while (true) {
    const data = await fetchJson(`${LMV_API_URL}?offset=${offset}&limit=${limit}&sprak=1`);
    const batch = Array.isArray(data.livsmedel) ? data.livsmedel : [];

    totalRecords ??= Number.isFinite(data?._meta?.totalRecords)
      ? data._meta.totalRecords
      : null;
    foods.push(...batch);

    if (batch.length < limit) break;
    offset += limit;
  }

  return { foods, totalRecords };
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

function extractCategory(classifications) {
  const mainGroup = classifications.find((item) => String(item.typ || "").toLowerCase() === "huvudgrupp");
  return String(mainGroup?.kod || mainGroup?.namn || "").trim();
}

async function fetchGroup(foodNumber) {
  try {
    const classifications = await fetchJson(`${LMV_API_URL}/${foodNumber}/klassificeringar?sprak=1`);
    const items = Array.isArray(classifications) ? classifications : [];

    return {
      group: String(extractGroup(items)).trim(),
      category: extractCategory(items)
    };
  } catch (error) {
    return { group: "", category: "" };
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

const { foods: rawFoods, totalRecords } = await fetchAllFoods();
const foods = await mapWithConcurrency(rawFoods, async (food) => {
  const name = String(food.namn || "").trim();
  const classification = await fetchGroup(food.nummer);

  return {
    id: food.nummer,
    name,
    slug: normalizeSlug(name),
    group: classification.group,
    category: classification.category
  };
});

const filteredFoods = foods
  .filter((food) => food.id && food.name && food.slug)
  .sort((a, b) => a.name.localeCompare(b.name, "sv"));

if (filteredFoods.length < MIN_EXPECTED_FOODS) {
  throw new Error(`Expected at least ${MIN_EXPECTED_FOODS} foods, got ${filteredFoods.length}`);
}

if (totalRecords !== null && Math.abs(filteredFoods.length - totalRecords) > 5) {
  throw new Error(`Expected roughly ${totalRecords} foods from API metadata, got ${filteredFoods.length}`);
}

const payload = {
  source: "Livsmedelsverket Livsmedelsdatabas",
  generatedAt: new Date().toISOString(),
  expectedFoodCount: totalRecords,
  foods: filteredFoods
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Wrote ${payload.foods.length} foods to ${OUTPUT_PATH.pathname}`);
