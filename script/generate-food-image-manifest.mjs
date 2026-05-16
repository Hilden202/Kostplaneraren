import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IMAGE_DIR = "images/foods";
const OUTPUT_PATH = new URL("../data/food-images.json", import.meta.url);
const IMAGE_EXTENSIONS = new Set([".png", ".webp", ".jpg", ".jpeg", ".avif"]);

async function trackedImageFiles() {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", IMAGE_DIR]);

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const entries = await readdir(new URL(`../${IMAGE_DIR}/`, import.meta.url));

    return entries.map((entry) => `${IMAGE_DIR}/${entry}`);
  }
}

const images = (await trackedImageFiles())
  .filter((path) => IMAGE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, "sv"))
  .map((path) => `/${path}`);

const payload = {
  source: "Tracked food image files for the local asset dashboard.",
  generatedAt: new Date().toISOString(),
  images
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${images.length} image paths to ${OUTPUT_PATH.pathname}`);
