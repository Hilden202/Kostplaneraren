(function () {
  const IMAGE_MANIFEST_URL = "/data/food-images.json";
  const GITHUB_IMAGE_CONTENTS_URL = "https://api.github.com/repos/Hilden202/Kostplaneraren/contents/images/foods?ref=main";
  const IMAGE_DIR = "/images/foods";
  const IMAGE_EXTENSION_ORDER = ["webp", "png", "jpg", "jpeg", "avif"];
  const IMAGE_EXTENSIONS = IMAGE_EXTENSION_ORDER.flatMap((extension) => [extension, extension.toUpperCase()]);

  const state = {
    imageIndex: null,
    imageIndexPromise: null,
    loadKey: ""
  };

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

  function foodSlug(value) {
    if (value && typeof value === "object") {
      return normalizeSlug(
        value.slug
        || value.Slug
        || value.namn
        || value.Namn
        || value.name
        || value.Name
        || value.livsmedelsnamn
        || value.Livsmedelsnamn
        || ""
      );
    }

    return normalizeSlug(value);
  }

  function imageCandidates(value) {
    const slug = foodSlug(value);
    return IMAGE_EXTENSIONS.map((extension) => `${IMAGE_DIR}/${slug}.${extension}`);
  }

  function cacheBusted(url) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}_assetScan=${Date.now()}`;
  }

  function normalizeImageManifestPath(value) {
    let path = String(value || "").trim();

    if (!path) return "";

    if (/^https?:\/\//i.test(path)) {
      try {
        path = new URL(path, window.location.origin).pathname;
      } catch (error) {
        return "";
      }
    }

    if (path.startsWith("/")) return path;
    if (path.startsWith("images/")) return `/${path}`;
    if (!path.includes("/")) return `${IMAGE_DIR}/${path}`;

    return path;
  }

  function isSupportedImagePath(path) {
    const extension = String(path || "").split(".").pop();
    return IMAGE_EXTENSIONS.some((candidate) => candidate.toLowerCase() === extension?.toLowerCase());
  }

  function parseImageRecords(payload) {
    const records = Array.isArray(payload)
      ? payload
      : payload?.images || payload?.files || [];

    return new Set(records
      .map((item) => {
        if (typeof item === "string") return normalizeImageManifestPath(item);
        return normalizeImageManifestPath(item?.path || item?.url || item?.name);
      })
      .filter((path) => path && isSupportedImagePath(path)));
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    return response.json();
  }

  async function loadDirectoryImageIndex() {
    const response = await fetch(cacheBusted(`${IMAGE_DIR}/`), { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Food image directory returned ${response.status}`);
    }

    const text = await response.text();
    const document = new DOMParser().parseFromString(text, "text/html");
    const paths = Array.from(document.querySelectorAll("a"))
      .map((link) => {
        const href = link.getAttribute("href") || "";
        try {
          return normalizeImageManifestPath(new URL(href, `${window.location.origin}${IMAGE_DIR}/`).pathname);
        } catch (error) {
          return "";
        }
      })
      .filter((path) => path.startsWith(`${IMAGE_DIR}/`) && isSupportedImagePath(path));

    if (paths.length === 0) {
      throw new Error("No food images found in directory listing");
    }

    return new Set(paths);
  }

  async function loadGitHubImageIndex() {
    const records = await fetchJson(cacheBusted(GITHUB_IMAGE_CONTENTS_URL));
    const index = parseImageRecords(records);

    if (index.size === 0) {
      throw new Error("GitHub image listing was empty");
    }

    return index;
  }

  async function loadManifestImageIndex() {
    const payload = await fetchJson(cacheBusted(IMAGE_MANIFEST_URL));
    const index = parseImageRecords(payload);

    if (index.size === 0) {
      throw new Error("Image manifest was empty");
    }

    return index;
  }

  function isLocalHost() {
    return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  }

  function getImageIndexLoaders(options = {}) {
    if (options.preferLive) {
      return isLocalHost()
        ? [loadDirectoryImageIndex, loadGitHubImageIndex, loadManifestImageIndex]
        : [loadGitHubImageIndex, loadManifestImageIndex];
    }

    return isLocalHost()
      ? [loadDirectoryImageIndex, loadManifestImageIndex, loadGitHubImageIndex]
      : [loadManifestImageIndex, loadGitHubImageIndex];
  }

  async function loadImageIndex(options = {}) {
    const loadKey = options.preferLive ? "live" : "manifest";

    if (!options.force && state.imageIndex && state.loadKey === loadKey) {
      return state.imageIndex;
    }

    if (!options.force && state.imageIndexPromise && state.loadKey === loadKey) {
      return state.imageIndexPromise;
    }

    state.loadKey = loadKey;
    state.imageIndexPromise = (async () => {
      const loaders = getImageIndexLoaders(options);

      for (const loader of loaders) {
        try {
          state.imageIndex = await loader();
          return state.imageIndex;
        } catch (error) {
          // Try the next source before falling back to URL probes.
        }
      }

      state.imageIndex = null;
      return null;
    })().finally(() => {
      state.imageIndexPromise = null;
    });

    return state.imageIndexPromise;
  }

  async function resourceExists(url, options = {}) {
    try {
      const response = await fetch(url, {
        method: options.method || "HEAD",
        cache: "no-store"
      });

      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async function probeImage(url) {
    if (await resourceExists(url)) return true;

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          Range: "bytes=0-0"
        }
      });

      return response.ok;
    } catch (error) {
      return false;
    }
  }

  function findMatchingImageInIndex(value, index) {
    const slug = foodSlug(value);
    const candidates = imageCandidates(slug);
    const match = candidates.find((url) => index?.has(url));

    return match
      ? { state: "completed", url: match, slug }
      : { state: "missing", url: null, slug };
  }

  async function findMatchingImage(value, options = {}) {
    const slug = foodSlug(value);

    if (!slug) {
      return { state: "missing", url: null, slug: "" };
    }

    const index = options.index ?? await loadImageIndex(options);

    if (index) {
      return findMatchingImageInIndex(slug, index);
    }

    if (options.probe === false) {
      return { state: "missing", url: null, slug };
    }

    for (const url of imageCandidates(slug)) {
      if (await probeImage(url)) {
        return { state: "completed", url, slug };
      }
    }

    return { state: "missing", url: null, slug };
  }

  function imageSlugFromPath(path) {
    const filename = decodeURIComponent(String(path || "").split("/").pop() || "");
    const basename = filename.replace(/\.[^.]+$/, "");
    return normalizeSlug(basename);
  }

  function countFoodImages(index = state.imageIndex) {
    if (!index) return 0;

    return new Set(Array.from(index)
      .map(imageSlugFromPath)
      .filter(Boolean)).size;
  }

  async function getProgress(totalFoods = 0, options = {}) {
    const index = await loadImageIndex(options);
    const completed = countFoodImages(index);
    const total = Number(totalFoods) || 0;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { completed, total, percent };
  }

  window.KostFoodImages = Object.freeze({
    IMAGE_DIR,
    IMAGE_EXTENSION_ORDER,
    IMAGE_EXTENSIONS,
    IMAGE_MANIFEST_URL,
    normalizeSlug,
    foodSlug,
    imageCandidates,
    normalizeImageManifestPath,
    isSupportedImagePath,
    parseImageRecords,
    loadImageIndex,
    findMatchingImage,
    findMatchingImageInIndex,
    countFoodImages,
    getProgress
  });
}());
