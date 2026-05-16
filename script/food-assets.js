(function () {
  const LMV_API_URL = "https://dataportal.livsmedelsverket.se/livsmedel/api/v1/livsmedel";
  const LOCAL_FOODS_URL = "/data/foods.json";
  const IMAGE_MANIFEST_URL = "/data/food-images.json";
  const IMAGE_DIR = "/images/foods";
  const IMAGE_EXTENSIONS = ["png", "PNG", "webp", "WEBP", "jpg", "JPG", "jpeg", "JPEG", "avif", "AVIF"];
  const CHECK_CONCURRENCY = 24;

  const elements = {
    list: document.getElementById("assetList"),
    search: document.getElementById("assetSearch"),
    sourceStatus: document.getElementById("sourceStatus"),
    refreshButton: document.getElementById("refreshButton"),
    datasetImport: document.getElementById("datasetImport"),
    totalCount: document.getElementById("totalCount"),
    completedCount: document.getElementById("completedCount"),
    missingCount: document.getElementById("missingCount"),
    checkingCount: document.getElementById("checkingCount"),
    visibleCount: document.getElementById("visibleCount"),
    filterTabs: Array.from(document.querySelectorAll(".filter-tab"))
  };

  const state = {
    foods: [],
    imageStatus: new Map(),
    filter: "all",
    search: "",
    checkRunId: 0,
    renderTimer: null,
    imageManifest: null
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

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getStatusForFood(food) {
    return state.imageStatus.get(food.slug) || { state: "checking", url: null };
  }

  function setSourceStatus(message, isError = false) {
    elements.sourceStatus.textContent = message;
    elements.sourceStatus.classList.toggle("is-error", isError);
  }

  function foodGroup(source) {
    return source.group
      ?? source.Group
      ?? source.grupp
      ?? source.Grupp
      ?? source.huvudgrupp
      ?? source.Huvudgrupp
      ?? source.huvudGrupp
      ?? "";
  }

  async function fetchAllFoods() {
    const limit = 2500;
    let offset = 0;
    const foods = [];

    while (true) {
      const url = `${LMV_API_URL}?offset=${offset}&limit=${limit}&sprak=1`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Livsmedelsverket returned ${response.status}`);
      }

      const data = await response.json();
      const batch = Array.isArray(data.livsmedel) ? data.livsmedel : [];

      foods.push(...batch.map((food) => ({
        id: food.nummer ?? food.id ?? "",
        name: food.namn ?? "",
        group: foodGroup(food)
      })));

      if (batch.length < limit) break;
      offset += limit;
    }

    return foods;
  }

  async function fetchLocalFoods() {
    const response = await fetch(LOCAL_FOODS_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Local foods fallback returned ${response.status}`);
    }

    return parseJsonFoodPayload(await response.json());
  }

  function parseJsonFoodPayload(payload) {
    if (Array.isArray(payload)) return payload;

    return payload?.foods
      || payload?.livsmedel
      || payload?.items
      || [];
  }

  function normalizeFoodRecords(records) {
    const seen = new Set();

    return records
      .map((record, index) => {
        const source = record && typeof record === "object" ? record : { name: record };
        const name = source.namn
          ?? source.Namn
          ?? source.name
          ?? source.Name
          ?? source.livsmedelsnamn
          ?? source.Livsmedelsnamn
          ?? "";

        const trimmedName = String(name).trim();
        const slug = normalizeSlug(source.slug || source.Slug || trimmedName);
        const group = String(foodGroup(source)).trim();

        return {
          id: source.nummer ?? source.Nummer ?? source.id ?? source.Id ?? index + 1,
          name: trimmedName,
          slug,
          group
        };
      })
      .filter((food) => food.name && food.slug)
      .filter((food) => {
        const key = `${food.id}:${food.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  }

  function detectDelimiter(text) {
    const firstLine = String(text).split(/\r?\n/, 1)[0] || "";
    const candidates = ["\t", ";", ","];
    let best = ",";
    let bestCount = -1;

    for (const delimiter of candidates) {
      const count = firstLine.split(delimiter).length - 1;
      if (count > bestCount) {
        best = delimiter;
        bestCount = count;
      }
    }

    return best;
  }

  function parseCsv(text) {
    const delimiter = detectDelimiter(text);
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;

    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      const next = text[index + 1];

      if (char === '"' && quoted && next === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") index++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }

    row.push(cell);
    rows.push(row);

    const cleanedRows = rows
      .map((items) => items.map((item) => item.trim()))
      .filter((items) => items.some(Boolean));

    if (cleanedRows.length === 0) return [];

    const headers = cleanedRows[0].map((item) => item.toLowerCase());
    const nameIndex = headers.findIndex((item) => ["namn", "name", "livsmedelsnamn"].includes(item));
    const idIndex = headers.findIndex((item) => ["nummer", "id", "livsmedelsnummer"].includes(item));
    const hasHeader = nameIndex >= 0;

    return cleanedRows.slice(hasHeader ? 1 : 0).map((items, index) => ({
      id: hasHeader && idIndex >= 0 ? items[idIndex] : index + 1,
      name: hasHeader ? items[nameIndex] : items[0]
    }));
  }

  async function importDataset(file) {
    const text = await file.text();
    let records;

    if (file.name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(text);
      records = parseJsonFoodPayload(parsed);
    } else {
      records = parseCsv(text);
    }

    setFoods(records, `Imported ${file.name}`);
  }

  function imageCandidates(slug) {
    return IMAGE_EXTENSIONS.map((extension) => `${IMAGE_DIR}/${slug}.${extension}`);
  }

  function normalizeImageManifestPath(value) {
    const path = String(value || "").trim();

    if (!path) return "";
    if (path.startsWith("/")) return path;
    if (path.startsWith("images/")) return `/${path}`;
    if (!path.includes("/")) return `${IMAGE_DIR}/${path}`;

    return path;
  }

  function parseImageManifest(payload) {
    const records = Array.isArray(payload)
      ? payload
      : payload?.images || payload?.files || [];

    return new Set(records
      .map((item) => {
        if (typeof item === "string") return normalizeImageManifestPath(item);
        return normalizeImageManifestPath(item?.path || item?.url || item?.name);
      })
      .filter(Boolean));
  }

  async function loadImageManifest() {
    try {
      const response = await fetch(IMAGE_MANIFEST_URL, { cache: "no-store" });

      if (!response.ok) {
        throw new Error(`Image manifest returned ${response.status}`);
      }

      state.imageManifest = parseImageManifest(await response.json());
    } catch (error) {
      state.imageManifest = null;
    }
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

  async function findMatchingImage(slug) {
    const candidates = imageCandidates(slug);

    if (state.imageManifest) {
      const match = candidates.find((url) => state.imageManifest.has(url));

      return match
        ? { state: "completed", url: match }
        : { state: "missing", url: null };
    }

    for (const url of candidates) {
      if (await probeImage(url)) {
        return { state: "completed", url };
      }
    }

    return { state: "missing", url: null };
  }

  async function checkImages() {
    const runId = ++state.checkRunId;
    const slugs = Array.from(new Set(state.foods.map((food) => food.slug)));
    let nextIndex = 0;

    await loadImageManifest();

    state.imageStatus = new Map(slugs.map((slug) => [slug, { state: "checking", url: null }]));
    render();

    async function worker() {
      while (nextIndex < slugs.length && runId === state.checkRunId) {
        const slug = slugs[nextIndex++];
        const status = await findMatchingImage(slug);

        if (runId !== state.checkRunId) return;

        state.imageStatus.set(slug, status);
        scheduleRender();
      }
    }

    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, slugs.length) }, worker));

    if (runId === state.checkRunId) {
      render();
    }
  }

  function statusTotals() {
    const totals = { completed: 0, missing: 0, checking: 0 };

    for (const food of state.foods) {
      const status = getStatusForFood(food).state;
      totals[status] = (totals[status] || 0) + 1;
    }

    return totals;
  }

  function filteredFoods() {
    const term = state.search.trim().toLowerCase();

    return state.foods.filter((food) => {
      const status = getStatusForFood(food).state;
      const matchesFilter = state.filter === "all"
        || (state.filter === "missing" && status === "missing")
        || (state.filter === "completed" && status === "completed");

      if (!matchesFilter) return false;
      if (!term) return true;

      return food.name.toLowerCase().includes(term)
        || food.slug.includes(term)
        || food.group.toLowerCase().includes(term);
    });
  }

  function renderStats(visibleRows) {
    const totals = statusTotals();

    elements.totalCount.textContent = state.foods.length.toLocaleString("sv-SE");
    elements.completedCount.textContent = totals.completed.toLocaleString("sv-SE");
    elements.missingCount.textContent = totals.missing.toLocaleString("sv-SE");
    elements.checkingCount.textContent = totals.checking.toLocaleString("sv-SE");
    elements.visibleCount.textContent = `${visibleRows.toLocaleString("sv-SE")} rows`;
  }

  function renderRows(foods) {
    if (foods.length === 0) {
      elements.list.innerHTML = state.foods.length
        ? '<div class="empty-message">No foods match the current view.</div>'
        : '<div class="empty-message">No food data loaded.</div>';
      return;
    }

    elements.list.innerHTML = foods.map((food) => {
      const status = getStatusForFood(food);
      const imageMarkup = status.url
        ? `<img class="asset-preview" src="${escapeHtml(status.url)}" alt="${escapeHtml(food.name)}" loading="lazy">`
        : '<div class="preview-missing" aria-label="Missing image">Missing</div>';
      const path = status.url || `${IMAGE_DIR}/${food.slug}.webp`;
      const statusLabel = status.state === "completed"
        ? "Completed"
        : status.state === "missing"
          ? "Missing"
          : "Checking";
      const meta = food.group ? `Group: ${food.group} | ID ${food.id}` : `ID ${food.id}`;

      return `
        <article class="asset-row" data-status="${escapeHtml(status.state)}">
          <div class="row-preview">${imageMarkup}</div>
          <div class="row-name">
            <p class="food-name">${escapeHtml(food.name)}</p>
            <p class="food-id">${escapeHtml(meta)}</p>
          </div>
          <div class="row-slug">
            <code class="slug-value">${escapeHtml(food.slug)}</code>
            <p class="slug-path">${escapeHtml(path)}</p>
          </div>
          <div class="row-status">
            <span class="status-badge ${escapeHtml(status.state)}">${statusLabel}</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function render() {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = null;

    const foods = filteredFoods();
    renderStats(foods.length);
    renderRows(foods);
  }

  function scheduleRender() {
    if (state.renderTimer) return;
    state.renderTimer = window.setTimeout(render, 120);
  }

  function setFoods(records, sourceLabel) {
    state.foods = normalizeFoodRecords(records);
    state.imageStatus.clear();
    state.search = elements.search.value;

    setSourceStatus(`${sourceLabel}: ${state.foods.length.toLocaleString("sv-SE")} foods`);
    checkImages().catch((error) => {
      setSourceStatus(`Image check failed: ${error.message}`, true);
    });
  }

  async function loadFromLivsmedelsverket() {
    setSourceStatus("Loading Livsmedelsverket foods...");
    elements.refreshButton.disabled = true;

    try {
      const foods = await fetchAllFoods();
      setFoods(foods, "Livsmedelsverket dataset");
    } catch (error) {
      setSourceStatus("Live API unavailable. Loading local foods.json fallback...");

      try {
        const foods = await fetchLocalFoods();
        setFoods(foods, "Local foods.json fallback");
        setSourceStatus(`Live API unavailable. Using local foods.json fallback. ${state.foods.length.toLocaleString("sv-SE")} foods loaded.`);
      } catch (fallbackError) {
        setSourceStatus(`Fetch failed: ${error.message}. Local fallback failed: ${fallbackError.message}`, true);
        render();
      }
    } finally {
      elements.refreshButton.disabled = false;
    }
  }

  elements.search.addEventListener("input", () => {
    state.search = elements.search.value;
    render();
  });

  elements.filterTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter || "all";
      elements.filterTabs.forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
      render();
    });
  });

  elements.refreshButton.addEventListener("click", loadFromLivsmedelsverket);

  elements.datasetImport.addEventListener("change", () => {
    const file = elements.datasetImport.files && elements.datasetImport.files[0];
    if (!file) return;

    importDataset(file).catch((error) => {
      setSourceStatus(`Import failed: ${error.message}`, true);
    }).finally(() => {
      elements.datasetImport.value = "";
    });
  });

  loadFromLivsmedelsverket();
}());
