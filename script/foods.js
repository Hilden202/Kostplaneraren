// =================================
// GLOBAL STATE
// =================================

//const url = "https://dataportal.livsmedelsverket.se/livsmedel/api/v1/livsmedel?offset=0&limit=2569&sprak=1";
const foodList = document.getElementById("foodList");
const nutritionOutput = document.getElementById("nutritionOutput");
const searchInput = document.getElementById("foodInput");
const DEFAULT_SLIDER_MAX = 1000;
const mobileDrawer = document.getElementById("mobileDrawer");
const drawerHandle = document.getElementById("drawerHandle");
const drawerContent = document.getElementById("drawerContent");

// =================================
// THEME
// =================================

const THEME_STORAGE_KEY = "kostplaneraren-theme";
const THEME_META_COLORS = {
  dark: "#07100d",
  light: "#f3eee4"
};

function getStoredTheme() {
  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "dark" || storedTheme === "light" ? storedTheme : null;
  } catch (error) {
    return null;
  }
}

function getSystemTheme() {
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    // Theme still applies for this page view if storage is unavailable.
  }
}

function updateThemeToggle(theme) {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;

  const isLight = theme === "light";
  const label = isLight
    ? "Ljust tema aktivt. Byt till mörkt läge"
    : "Mörkt tema aktivt. Byt till ljust läge";
  const text = toggle.querySelector(".theme-toggle-text");

  toggle.setAttribute("aria-label", label);
  toggle.setAttribute("aria-pressed", isLight ? "true" : "false");
  toggle.title = label;
  if (text) text.textContent = isLight ? "Ljust" : "Mörkt";
}

function applyTheme(theme, options = {}) {
  const nextTheme = theme === "light" ? "light" : "dark";

  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", THEME_META_COLORS[nextTheme]);

  updateThemeToggle(nextTheme);

  if (options.persist) {
    setStoredTheme(nextTheme);
  }
}

function initThemeToggle() {
  const initialTheme = document.documentElement.dataset.theme || getStoredTheme() || getSystemTheme();
  const toggle = document.getElementById("themeToggle");
  const systemThemeQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  applyTheme(initialTheme);

  toggle?.addEventListener("click", () => {
    const currentTheme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    applyTheme(currentTheme === "light" ? "dark" : "light", { persist: true });
  });

  const syncSystemTheme = () => {
    if (!getStoredTheme()) {
      applyTheme(getSystemTheme());
    }
  };

  if (systemThemeQuery?.addEventListener) {
    systemThemeQuery.addEventListener("change", syncSystemTheme);
  } else if (systemThemeQuery?.addListener) {
    systemThemeQuery.addListener(syncSystemTheme);
  }
}

initThemeToggle();

// Backdrop för klick-utanför-stäng
const drawerBackdrop = mobileDrawer?.querySelector(".drawer-backdrop");
drawerBackdrop?.addEventListener("click", () => {
  setDrawerOpen(false);                 // stänger och uppdaterar aria/overflow
});

const getPageChunk = () => (isMobile() ? 25 : 50);

// --- Källa: Livsmedelsverket ---
const LMV_SOURCE_URL = "https://soknaringsinnehall.livsmedelsverket.se/";
const LMV_VERSION = "2025-10-29"; // hårdkodat för nuvarande version

function deriveLmvVersion(rawText) { //Denna fungerar inte just nu
  // matchar "version YYYY-MM-DD" (skiftlägesokänsligt, tolererar extra mellanrum)
  const m = /version\s+(\d{4}-\d{2}-\d{2})/i.exec(rawText || "");
  return m ? m[1] : null;
}

let currentList = [];
let renderedCount = 0;
let isAppending = false;
let io = null;
let sentinel = null;
let dietFilter = { type: 'all' };
let activeQuickFilter = null;
let changingFromQuickFilter = false;

const nutritionCache = new Map(); // cache för /naringsvarden per livsmedels-id
const classCache = new Map();     // cache för /klassificeringar per livsmedels-id

// Låsflagga för header (true medan sökfältet är i fokus)
let headerLock = false;

// Extra lås medan man aktivt skriver (släpps strax efter sista input)
let typingLock = false;
let typingUnlockTimer = null;
const TYPING_UNLOCK_MS = 600; // justera vid behov

function isHeaderLocked() {
  return headerLock || typingLock;
}

// Scrolla bara resultatkolumnen (inte fönstret)
function scrollResultsTopNoWindow() {
  const left = document.querySelector('.main-left');
  if (left && (left.scrollHeight - left.clientHeight) > 2) {
    left.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
  }
  return false;
}

function setDrawerOpen(open) {
  if (!isMobile()) return;
  mobileDrawer.classList.toggle("open", open);
  drawerHandle.setAttribute("aria-expanded", open ? "true" : "false");
  mobileDrawer.setAttribute("aria-hidden", open ? "false" : "true");

  document.documentElement.style.overflow = open ? "hidden" : "";
  document.body.style.overflow = open ? "hidden" : "";

  if (open) {
    drawerContent.scrollTop = 0;
    requestAnimationFrame(adjustSelectedListHeight);
  }

  // refresh the little "(n)" visibility on every toggle
  updateDrawerCount();
}

function updateDrawerCount() {
  const el = document.getElementById('drawerCount');
  if (!el) return;

  const count = (selectedFoods?.length || 0);

  // only show when drawer is CLOSED and there are items
  const drawerIsClosed = !mobileDrawer?.classList.contains('open');
  const shouldShow = isMobile() && drawerIsClosed && count > 0;

  el.textContent = shouldShow ? `(${count})` : '';
}



function getScrollRoot() {
  const left = document.querySelector('.main-left');
  if (left && (left.scrollHeight - left.clientHeight) > 2) {
    return left;                // .main-left är verkliga skrollcontainern
  }
  return null;                  // fall tillbaka till window
}

function lvFoodUrl(id) {
  // ev. sökord/kategori-parametrar behövs inte – sidan funkar fint utan
  return `https://soknaringsinnehall.livsmedelsverket.se/Home/FoodDetails/${id}`;
}

// =================================
// EMPTY STATES
// =================================

function showEmptyState() {
  nutritionOutput.innerHTML = `
    <div id="emptyState" class="empty-state">
      <h2>Välkommen till Kostplaneraren</h2>
      <p>Skriv i sökfältet ovan för att börja. Exempel: <em>ägg</em>, <em>kyckling</em>, <em>broccoli</em>.</p>

      <hr class="empty-divider">

      <p class="source-note">
        <strong>Källa:</strong>
        <a href="${LMV_SOURCE_URL}" target="_blank" rel="noopener">Livsmedelsverkets Livsmedelsdatabas</a>
        version <span id="lmvVer">${LMV_VERSION}</span>.<br>
      </p>
      <p class="site-disclaimer">
        Denna webbplats är ett privat projekt och inte en officiell tjänst från Livsmedelsverket.
      </p>
    </div>
    <div id="resultsCards" hidden></div>
    <div class="loadmore-bar">
      <button id="loadMoreBtn" style="display:none;">Visa fler</button>
    </div>`;
}

function showNoHits(term) {
  nutritionOutput.innerHTML = `
    <div class="empty-state">
      <h2>Inga träffar</h2>
      <p>Hittade inget som matchar <strong>${term}</strong>. Prova ett annat ord.</p>
    </div>
    <div id="resultsCards" hidden></div>
    <div class="loadmore-bar">
      <button id="loadMoreBtn" style="display:none;">Visa fler</button>
    </div>`;
}

function clearEmptyStates() {
  // ta bort både välkomst-rutan och "inga träffar"-rutan
  document.querySelectorAll('.empty-state').forEach(el => el.remove());
}

// =================================
// FILTERING
// =================================

const dietSelect = document.getElementById('dietSelect');
dietSelect?.addEventListener('change', () => {

  // 🔥 Endast om användaren ändrade dropdownen manuellt
  if (!changingFromQuickFilter) {
    activeQuickFilter = null;
    document.querySelectorAll(".quick-filters button")
      .forEach(b => b.classList.remove("is-active"));
  }

  const v = dietSelect.value;

  const map = {
    'alla':        'all',
    'keto_x':      'keto3',
    'lchf_strikt': 'lchf5',
    'lchf_liberal':'lchf10',
    'hogprotein':  'hp20',
    'lag_fett':    'lowfat3',
    'lag_mattat':  'lowsat1_5',
    'medelhav':    'medelhav',
    'lag_socker':  'sugar5',
    'lag_salt':    'lowsalt0_3',
    'fiberrik':    'fiber6',
    'lag_energi':  'lowkcal80'
  };

  dietFilter = { type: map[v] ?? 'all' };
  doSearch(searchInput.value);
});


function unlockTypingSoon(delay = 450){
  clearTimeout(typingUnlockTimer);
  typingUnlockTimer = setTimeout(() => {
    typingLock = false;
    applyHeaderVisibility();
  }, delay);
}

const clearBtn = document.getElementById("clearSearch");

// =================================
// SEARCH
// =================================

// 1) Vårt eget kryss (knapp)
clearBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();

  // rensa bara inputen
  clearTimeout(inputDebounce);       // stoppa ev. pågående sökdebounce
  searchInput.value = "";
  clearBtn.style.visibility = "hidden";

  // behåll fokus utan att skrolla/”väcka” headern
  searchInput.focus({ preventScroll: true });
});

// 2) Native kryss i <input type="search"> (iOS/Chrome)
// Det här eventet triggas när man klickar på det inbyggda krysset.
searchInput.addEventListener("search", (e) => {
  if (searchInput.value === "") {
    clearTimeout(inputDebounce);
    clearBtn?.style && (clearBtn.style.visibility = "hidden");
    // inget doSearch här – vi rör inte listan eller scroll
    searchInput.focus({ preventScroll: true });
  }
});

// (valfritt) Stäng även på ESC
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setDrawerOpen(false);
});

// Referenser för desktop-kolumnen
const selectedFoodsListEl = document.getElementById("selectedFoodsList");
const summaryEl = document.getElementById("summary");
const sidebarHeader = document.querySelector(".sidebar-header");

// =================================
// MOBILE COLLAPSIBLE HEADER
// =================================

function getHeaderScrollRoot() {
  return isMobileAny() ? window : (getScrollRoot() || window);
}

function getScrollY() {
  const root = getHeaderScrollRoot();
  return root === window ? window.scrollY : root.scrollTop;
}

const mobileHeaderPanel = (() => {
  const COLLAPSE_SCROLL_Y = 96;
  const TOP_EXPAND_Y = 6;
  const MANUAL_SCROLL_DELTA = 42;
  const DRAG_TRIGGER_Y = 26;

  let collapsed = false;
  let lastScrollY = 0;
  let manualExpandedAtY = null;
  let scrollingRAF = null;
  let unbindScroll = null;
  let handleBound = false;
  let dragState = null;
  let suppressNextClick = false;

  const getHeader = () => document.querySelector(".header-top");
  const getHandle = () => document.getElementById("mobileHeaderHandle");
  const getPanel = () => document.getElementById("mobileHeaderPanel");

  function refreshDependentLayout() {
    requestAnimationFrame(() => {
      setHeaderHeightVar();
      adjustSelectedListHeight();
    });
  }

  function updateHandle(isCollapsed) {
    const handle = getHandle();
    if (!handle) return;

    const isExpanded = isMobileAny() && !isCollapsed;
    const label = isCollapsed ? "Visa hela toppanelen" : "Dölj toppanelen";

    handle.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    handle.setAttribute("aria-label", label);
    handle.title = label;
  }

  function updatePanelAccess(isCollapsed) {
    const panel = getPanel();
    if (!panel) return;

    if (isCollapsed && isMobileAny()) {
      panel.setAttribute("aria-hidden", "true");
      panel.inert = true;
      return;
    }

    panel.removeAttribute("aria-hidden");
    panel.inert = false;
  }

  function setCollapsed(nextCollapsed) {
    const header = getHeader();
    if (!header) return;

    if (!isMobileAny()) {
      collapsed = false;
      manualExpandedAtY = null;
      header.classList.remove("header-collapsed", "header-expanded", "header-hidden");
      document.documentElement.classList.remove("hdr-collapsed", "hdr-hidden");
      updatePanelAccess(false);
      updateHandle(false);
      return;
    }

    collapsed = Boolean(nextCollapsed);
    header.classList.toggle("header-collapsed", collapsed);
    header.classList.toggle("header-expanded", !collapsed);
    header.classList.remove("header-hidden");
    document.documentElement.classList.toggle("hdr-collapsed", collapsed);
    document.documentElement.classList.remove("hdr-hidden");
    updatePanelAccess(collapsed);
    updateHandle(collapsed);
    refreshDependentLayout();
  }

  function expand(options = {}) {
    if (options.manual) {
      manualExpandedAtY = getScrollY();
    }
    setCollapsed(false);
  }

  function collapse(options = {}) {
    if (isHeaderLocked()) return;
    if (options.manual) {
      manualExpandedAtY = null;
    }
    setCollapsed(true);
  }

  function refreshFromScroll() {
    const header = getHeader();
    if (!header) return;

    const y = getScrollY();

    if (!isMobileAny()) {
      setCollapsed(false);
      lastScrollY = y;
      return;
    }

    if (isHeaderLocked()) {
      manualExpandedAtY = null;
      setCollapsed(false);
      lastScrollY = y;
      return;
    }

    if (y <= TOP_EXPAND_Y) {
      manualExpandedAtY = null;
      setCollapsed(false);
      lastScrollY = y;
      return;
    }

    const scrollingDown = y > lastScrollY + 1;

    if (collapsed) {
      lastScrollY = y;
      return;
    }

    if (manualExpandedAtY !== null) {
      const collapseAfter = Math.max(COLLAPSE_SCROLL_Y, manualExpandedAtY + MANUAL_SCROLL_DELTA);
      if (scrollingDown && y > collapseAfter) {
        manualExpandedAtY = null;
        setCollapsed(true);
      }
      lastScrollY = y;
      return;
    }

    if (scrollingDown && y > COLLAPSE_SCROLL_Y) {
      setCollapsed(true);
    }

    lastScrollY = y;
  }

  function onScroll() {
    if (scrollingRAF) return;
    scrollingRAF = requestAnimationFrame(() => {
      scrollingRAF = null;
      refreshFromScroll();
    });
  }

  function bindScroll() {
    const root = getHeaderScrollRoot();
    if (unbindScroll) unbindScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    unbindScroll = () => root.removeEventListener("scroll", onScroll);
    lastScrollY = getScrollY();
    refreshFromScroll();
  }

  function finishDrag(event) {
    const handle = getHandle();
    window.removeEventListener("mousemove", onMouseMove);

    if (dragState && event?.pointerId !== undefined) {
      try {
        handle?.releasePointerCapture(event.pointerId);
      } catch (error) {
        // The pointer may already be released by the browser.
      }
    }
    dragState = null;

    if (suppressNextClick) {
      window.setTimeout(() => {
        suppressNextClick = false;
      }, 350);
    }
  }

  function startDrag(clientY) {
    if (!isMobileAny()) return;
    dragState = {
      startY: clientY,
      startedCollapsed: collapsed
    };
  }

  function updateDrag(clientY, event) {
    if (!dragState || !isMobileAny()) return;

    const deltaY = clientY - dragState.startY;

    if (dragState.startedCollapsed && deltaY > DRAG_TRIGGER_Y) {
      event?.preventDefault?.();
      suppressNextClick = true;
      expand({ manual: true });
      finishDrag(event);
      return;
    }

    if (!dragState.startedCollapsed && deltaY < -DRAG_TRIGGER_Y) {
      event?.preventDefault?.();
      suppressNextClick = true;
      collapse({ manual: true });
      finishDrag(event);
    }
  }

  function onPointerDown(event) {
    startDrag(event.clientY);
    if (!dragState) return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture is a progressive enhancement for steadier dragging.
    }
  }

  function onPointerMove(event) {
    updateDrag(event.clientY, event);
  }

  function onMouseDown(event) {
    if (event.button !== 0) return;
    startDrag(event.clientY);
    if (!dragState) return;

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp, { once: true });
  }

  function onMouseMove(event) {
    updateDrag(event.clientY, event);
  }

  function onMouseUp(event) {
    finishDrag(event);
  }

  function onTouchStart(event) {
    const touch = event.touches?.[0];
    if (!touch) return;
    startDrag(touch.clientY);
  }

  function onTouchMove(event) {
    const touch = event.touches?.[0];
    if (!touch) return;
    updateDrag(touch.clientY, event);
  }

  function onTouchEnd(event) {
    finishDrag(event);
  }

  function onHandleClick() {
    if (!isMobileAny()) return;

    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (collapsed) {
      expand({ manual: true });
    } else {
      collapse({ manual: true });
    }
  }

  function bindHandle() {
    if (handleBound) return;
    const handle = getHandle();
    if (!handle) return;

    handle.addEventListener("click", onHandleClick);
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    handle.addEventListener("mousedown", onMouseDown);
    handle.addEventListener("touchstart", onTouchStart, { passive: true });
    handle.addEventListener("touchmove", onTouchMove, { passive: false });
    handle.addEventListener("touchend", onTouchEnd);
    handle.addEventListener("touchcancel", onTouchEnd);
    handleBound = true;
  }

  function init() {
    bindHandle();
    setCollapsed(false);
    bindScroll();
  }

  return {
    init,
    bindScroll,
    refresh: refreshFromScroll,
    expand,
    collapse
  };
})();

function applyHeaderVisibility() {
  mobileHeaderPanel.refresh();
}

function bindAutoHideHeader() {
  mobileHeaderPanel.bindScroll();
}

// =================================
// DRAWER
// =================================

// =================================
// UTILITIES
// =================================

function makeFinder(nutritionData){
  const rows = (nutritionData || []).map(n => ({
    key: (n.namn || "").toLowerCase().trim().replace(/\s+/g,' '),
    rawName: n.namn || "",
    value: Number(n.varde),
    unit: n.enhet || ""
  }));
  const norm = s => s.toLowerCase().trim().replace(/\s+/g,' ');
  return (aliases) => {
    const al = aliases.map(norm);
    // 1) exakt match
    let hit = rows.find(r => al.includes(r.key));
    // 2) prefix
    if (!hit) hit = rows.find(r => al.some(a => r.key.startsWith(a)));
    // 3) inkluderar, men uteslut fettsyror
    if (!hit) hit = rows.find(r => al.some(a => r.key.includes(a)) && !/fettsyra|fettsyror/.test(r.key));
    return hit ? { value: hit.value, unit: hit.unit, label: hit.rawName } : null;
  };
}

function onModalBackdropClick(e) {
  // Stäng om klicket/touchen inte var inne i rutan
  if (!e.target.closest('.modal-content')) {
    closeFoodModal();
  }
}

// =================================
// CARD RENDERING
// =================================

function ensureResultsHeader(totalCount) {
  const cardsWrap = document.getElementById('resultsCards');
  if (!cardsWrap) return;

  let header = document.getElementById('resultsHeader');
  if (!header) {
    header = document.createElement('div');
    header.id = 'resultsHeader';
    header.className = 'results-header';
    cardsWrap.before(header);
  }

  const countLabel = totalCount === 1 ? '1 livsmedel' : `${totalCount} livsmedel`;
  header.innerHTML = `
    <h2>Sökresultat</h2>
    <span class="results-count">${countLabel}</span>
  `;
}

function renderInit(list, version, signal) {
  currentList = list || [];
  renderedCount = 0;
  isAppending = false;

  clearEmptyStates();

  // Se till att scaffold finns (empty-state skapar resultsCards + knapp)
  if (!document.getElementById('resultsCards')) {
    showEmptyState();
  }
  // Rensa tidigare kort för ny rendering
  const cardsWrap = document.getElementById('resultsCards');
  if (cardsWrap) cardsWrap.innerHTML = '';
  ensureResultsHeader(currentList.length);
  // Se till att knappen börjar dold
  const btn = document.getElementById('loadMoreBtn');
  if (btn) btn.style.display = 'none';

  // Skapa/injicera sentinel för infinite scroll
  document.querySelectorAll('#resultsSentinel').forEach(el => el.remove());
  sentinel = document.createElement('div');
  sentinel.id = 'resultsSentinel';
  sentinel.style.height = '1px';
  nutritionOutput.appendChild(sentinel);

  // Koppla knapp
  if (btn) btn.onclick = async () => {
   btn.disabled = true;
   const oldText = btn.textContent;
   btn.textContent = 'Laddar…';
   await renderNextChunk(version, signal);
   btn.disabled = false;
   btn.textContent = oldText;
 };

  setupInfiniteScroll(version, signal);
  renderNextChunk(version, signal); // första chunk
}

async function renderNextChunk(version, signal) {
  if (isAppending) return;
  if (renderedCount >= currentList.length) return;

  isAppending = true;
  // dölj knappen medan vi arbetar, så den inte “studsar”
  const btn = document.getElementById('loadMoreBtn');
  if (btn) btn.style.display = 'none';

  const start = renderedCount;
  const pageSize = getPageChunk();
  const end = Math.min(start + pageSize, currentList.length);
  const chunk = currentList.slice(start, end);

  // 🔑 Append bara nya kort – rör inte redan renderat
  const shownInChunk = await renderFoodCardsAppend(chunk, version, signal);
  renderedCount = end;
  isAppending = false;

  clearEmptyStates();

  // Om vi fick för få i denna chunk: hämta nästa chunk automatiskt
  if (shownInChunk < 6 && renderedCount < currentList.length) {
    // fortsätt mata tills vi uppnått 6 kort eller tar slut
    return renderNextChunk(version, signal);
  }

  // Om inget kort alls synts och allt är slut → ingen träff
  const anyVisible = document.querySelector('.food-card');
  if (!anyVisible && renderedCount >= currentList.length) {
    nutritionOutput.innerHTML = `
      <div class="empty-state">
        <h2>Inga träffar för valt filter</h2>
        <p>Justera filtret eller sökordet och försök igen.</p>
      </div>
    `;
  }
  // Annars: visa knappen om det finns mer att hämta
  if (btn) btn.style.display = (renderedCount < currentList.length) ? 'inline-block' : 'none';

  // Flytta sentinel sist så IO triggar när vi når botten igen
  if (sentinel && sentinel.parentNode !== nutritionOutput) {
    nutritionOutput.appendChild(sentinel);
  }
  // Om IO finns: se till att den observerar aktuell sentinel
  if (io && sentinel) io.observe(sentinel);
}

function setupInfiniteScroll(version, signal) {
  // Fallback till "Visa fler"-knapp om IO saknas
  const btn = document.getElementById('loadMoreBtn');
  if (!('IntersectionObserver' in window)) {
    if (btn) btn.style.display = 'inline-block';
    return;
  }
  if (io) io.disconnect();

  const scrollRoot = getScrollRoot(); // 👈 dynamiskt: .main-left eller window
  io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) renderNextChunk(version, signal);
    });
  }, { root: scrollRoot, rootMargin: '800px', threshold: 0 });

  if (sentinel) io.observe(sentinel);
}


function setHeaderHeightVar() {
  const h = document.querySelector(".header-top")?.offsetHeight || 0;
  document.documentElement.style.setProperty("--header-h", `${h}px`);
}
window.addEventListener("load", setHeaderHeightVar);

function isMobileLandscape(){
  return window.matchMedia("(max-width: 768px) and (orientation: landscape)").matches;
}

function isMobileAny(){
  return window.matchMedia("(max-width: 768px)").matches;
}

function isMobile() {
  return window.matchMedia("(max-width: 768px) and (orientation: portrait)").matches;
}

function mountIntoDrawer() {
  if (!isMobile()) return;
  if (!drawerContent.contains(sidebarHeader))      drawerContent.prepend(sidebarHeader);
  if (!drawerContent.contains(selectedFoodsListEl)) drawerContent.append(selectedFoodsListEl);
  if (!drawerContent.contains(summaryEl))           drawerContent.append(summaryEl);
}

function mountBackToRightColumn() {
  if (isMobile()) return;
  const rightInner = document.querySelector(".right-inner");
  if (!rightInner.contains(sidebarHeader))        rightInner.prepend(sidebarHeader);
  if (!rightInner.contains(selectedFoodsListEl))  rightInner.append(selectedFoodsListEl);
  if (!rightInner.contains(summaryEl))            rightInner.append(summaryEl);
}

 // Toggle på klick (bara på mobil)
 drawerHandle?.addEventListener("click", () => {
   if (!isMobile()) return;
   const nowOpen = !mobileDrawer.classList.contains("open");
   setDrawerOpen(nowOpen);
 });

 // Flytta in/ut vid start & vid resize
 function syncDrawerMount() {
   if (isMobile()) {
     mountIntoDrawer();
   } else {
     setDrawerOpen(false);
     mountBackToRightColumn();
     // återställ ev. overflow på desktop
     document.documentElement.style.overflow = "";
     document.body.style.overflow = "";
   }
   // efter mount: justera höjdbegränsning
   requestAnimationFrame(adjustSelectedListHeight);

  // Root kan ha ändrats (mobil ↔ desktop), bygg om IO
  setupInfiniteScroll(currentSearchVersion, currentAbortController?.signal);

 }

// Enhetlig resize-handler (debouncad via rAF)
const onResize = (() => {
  let rAF = null;
  return () => {
    if (rAF) return;
    rAF = requestAnimationFrame(() => {
      rAF = null;
      setHeaderHeightVar();     // uppdatera --header-h
      syncDrawerMount();        // flytta in/ut innehåll mellan drawer/kolumn
      adjustSelectedListHeight(); // räkna om list-höjd
      updateDrawerCount();      // uppdatera "(n)"
    });
  };
})();
window.addEventListener("resize", onResize);
window.addEventListener("resize", () => bindAutoHideHeader());

// iOS rotation: tvinga reflow i drawern så textstorlek inte "fastnar"
window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    setHeaderHeightVar();
    if (mobileDrawer?.classList.contains("open")) {
      const panel = document.getElementById("drawerContent");
      if (panel) {
        panel.style.display = "none";
        void panel.offsetHeight;   // force reflow
        panel.style.display = "";
      }
    }
    adjustSelectedListHeight();
    updateDrawerCount();
    bindAutoHideHeader();
  }, 60);
});

document.addEventListener("DOMContentLoaded", () => {
  syncDrawerMount();       // flytta in denna
  showEmptyState();        // din välkomstvy
  updateDrawerCount();     // initiera "(n)" direkt
  mobileHeaderPanel.init();
});

document.getElementById("homeReset")?.addEventListener("click", (e) => {
  e.preventDefault(); // stoppa navigation

  // 1. Rensa sök
  searchInput.value = "";
  lastSearchTerm = "";

  // 2. Reset filter-state
  dietFilter = { type: "all" };
  activeQuickFilter = null;
  changingFromQuickFilter = false;

  // 3. Reset UI
  document.getElementById("dietSelect").value = "alla";
  document
    .querySelectorAll(".quick-filters button")
    .forEach(b => b.classList.remove("is-active"));

  // 4. Visa startläget
  showEmptyState();

  // (valfritt) stäng mobil-drawer
  setDrawerOpen(false);
});

let foodData = [];
let selectedFoods = [];
let currentSearchVersion = 0;
let lastSearchTerm = "";
let currentAbortController = null;
let inputDebounce = null;

// Hjälp-funktion: jämför två namn utifrån ett sökord
function compareBySearch(a, b, term) {
  const t = term.toLowerCase();
  const an = a.namn.toLowerCase();
  const bn = b.namn.toLowerCase();

  const aExact = an === t;
  const bExact = bn === t;
  if (aExact !== bExact) return bExact - aExact; // exact match först

  const aStarts = an.startsWith(t);
  const bStarts = bn.startsWith(t);
  if (aStarts !== bStarts) return bStarts - aStarts; // börjar med term härnäst

  const ai = an.indexOf(t);
  const bi = bn.indexOf(t);
  if (ai !== bi) return ai - bi; // lägre index först

  if (an.length !== bn.length) return an.length - bn.length; // kortare namn först
  return an.localeCompare(bn, 'sv'); // stabil alfabetisk ordning (svenska)
}

async function fetchAllFoods() {
  const limit = 2500;   // sidstorlek
  let offset = 0;
  let all = [];

  while (true) {
    const res = await fetch(
      `https://dataportal.livsmedelsverket.se/livsmedel/api/v1/livsmedel?offset=${offset}&limit=${limit}&sprak=1`
    );
    const data = await res.json();

    const batch = (data.livsmedel || []).map(food => ({
      id: food.nummer,
      namn: food.namn
    }));

    all.push(...batch);

    if (batch.length < limit) break; // sista sidan nådd
    offset += limit;
  }
  return all;
}

fetchAllFoods()
  .then(list => {
    foodData = list;
    
    // Låt tom-state ligga kvar tills användaren söker.
    // Om du vill återställa tom-state när data kommit första gången:
    if (!document.getElementById('resultsCards')) {
      showEmptyState();
    }
  })
  .catch(err => console.error("Fel vid hämtning av alla livsmedel:", err));


function scrollToResultsTopWithOffset({ instant = false } = {}) {
  const headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0;
  const firstCard = document.querySelector('.food-card') || document.getElementById('resultsCards') || nutritionOutput;
  if (!firstCard) return;

  const left = document.querySelector('.main-left');
  const behavior = instant ? "auto" : "smooth";  // <-- viktiga ändringen

  if (left && (left.scrollHeight - left.clientHeight) > 2) {
    const y = Math.max(0, firstCard.offsetTop - headerH - 8);
    left.scrollTo({ top: y, behavior });
    return;
  }

  const y = Math.max(0, firstCard.getBoundingClientRect().top + window.scrollY - headerH - 8);
  window.scrollTo({ top: y, behavior });
}

function keepSearchInView() {
  // bara när tangentbordet är uppe (dvs headerLock) och i liggande
  if (headerLock && isMobileLandscape()) {
    requestAnimationFrame(() => {
      searchInput.scrollIntoView({ block: "center", behavior: "auto" });
    });
  }
}

function doSearch(rawTerm) {
  const searchTerm = (rawTerm || "").toLowerCase();
  lastSearchTerm = searchTerm.trim();

  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  currentSearchVersion++;

  if (!lastSearchTerm) {
    renderInit(foodData, currentSearchVersion, currentAbortController.signal);
requestAnimationFrame(() => {
  if (isMobileLandscape()) {
    scrollToResultsTopWithOffset({ instant: true });
    searchInput.scrollIntoView({ block: "center", behavior: "auto" });
  } else {
    scrollToResultsTopWithOffset({ instant: false });
  }
});

    return;
  }

  const filteredData = foodData
    .filter(item => item.namn.toLowerCase().includes(lastSearchTerm))
    .sort((a, b) => compareBySearch(a, b, lastSearchTerm));

  if (filteredData.length === 0) {
    showNoHits(lastSearchTerm);
    return;
  }

  renderInit(filteredData, currentSearchVersion, currentAbortController.signal);

requestAnimationFrame(() => {
  if (isMobileLandscape()) {
    scrollToResultsTopWithOffset({ instant: true });
    searchInput.scrollIntoView({ block: "center", behavior: "auto" });
  } else {
    scrollToResultsTopWithOffset({ instant: false });
  }
});
}

// Init: visa/dölj kryss
if (clearBtn) clearBtn.style.visibility = searchInput.value ? "visible" : "hidden";

searchInput.addEventListener("input", () => {
  typingLock = true;                         // lås medan vi skriver
  const term = searchInput.value;
  if (clearBtn) clearBtn.style.visibility = term ? "visible" : "hidden";

  clearTimeout(inputDebounce);
  inputDebounce = setTimeout(() => {
    doSearch(term);
    if (headerLock && isMobileLandscape()) {
      searchInput.scrollIntoView({ block: "center", behavior: "auto" });
    }
    unlockTypingSoon(450);                   // släpp låset strax efter render
  }, 150);
});

searchInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    event.preventDefault();
    clearTimeout(inputDebounce);
    doSearch(searchInput.value);
  }
});

searchInput.addEventListener("focus", () => {
  headerLock = true; // håller headern synlig via isHeaderLocked()
  mobileHeaderPanel.expand();
  // se till att fältet syns i landskap
  if (isMobileLandscape()) {
    setTimeout(() => {
      searchInput.scrollIntoView({ block: "center", behavior: "auto" });
    }, 0);
  }
});

searchInput.addEventListener("blur", () => {
  headerLock = false;
  requestAnimationFrame(applyHeaderVisibility); // återgå till auto-hide
});

function buildFilterPredicate(filterType) {
  switch (filterType) {
    case 'keto3':   return n => (n.netCarbs ?? n.carbs) <= 3;
    case 'lchf5':   return n => (n.netCarbs ?? n.carbs) <= 5;
    case 'lchf10':  return n => (n.netCarbs ?? n.carbs) <= 10;
    case 'hp20':    return n => n.protein >= 20;
    case 'lowfat3':   return n => n.fat <= 3;
    case 'lowsat1_5': return n => (n.satFat ?? Infinity) <= 1.5;
    case 'medelhav':  return n => {
      // Approx: omättat ≈ totalt fett − mättat fett
      if (!Number.isFinite(n.fat) || !Number.isFinite(n.satFat)) return false;
      const unsat = Math.max(0, n.fat - n.satFat);
      return unsat >= 2 * n.satFat;
    };
    case 'sugar5':    return n => (n.sugar ?? 0) <= 5;
    case 'lowsalt0_3':return n => (n.salt  ?? Infinity) <= 0.3;
    case 'fiber6':    return n => (n.fiber ?? 0) >= 6;
    case 'lowkcal80': return n => n.kcal <= 80;
    // kvar från tidigare om du använder dem någon annanstans
    case 'lean':      return n => n.protein >= 20 && n.fat <= 5;
    case 'lc50':      return n => n.kcal <= 50;
    case 'hf15':      return n => n.fat >= 15;
    case 'fiber5':    return n => (n.fiber ?? 0) >= 5;
    case 'all':
    default:        return _ => true;
  }
}

// Lightweight visual system for food cards. No network dependency, and future
// real images can be added in FOOD_IMAGE_OVERRIDES without changing rendering.
const FOOD_IMAGE_OVERRIDES = new Map();
const FOOD_VISUAL_CATEGORIES = [
  { key: 'eggs', label: 'Ägg', icon: 'fa-solid fa-egg', test: /(^|\W)(ägg|agg|egg)/i },
  { key: 'chicken', label: 'Fågel', icon: 'fa-solid fa-drumstick-bite', test: /kyckling|höns|hons|kalkon|fågel|fagel/i },
  { key: 'fish', label: 'Fisk', icon: 'fa-solid fa-fish', test: /lax|torsk|sill|makrill|fisk|räk|rak|skaldjur|tonfisk|sej|kolja/i },
  { key: 'meat', label: 'Kött', icon: 'fa-solid fa-bacon', test: /nötkött|notkott|fläsk|flask|gris|lamm|kött|kott|biff|korv|skinka|bacon/i },
  { key: 'vegetables', label: 'Grönt', icon: 'fa-solid fa-carrot', test: /broccoli|grönsak|gronsak|sallad|spenat|kål|kal|morot|tomat|gurka|paprika|lök|lok|svamp|zucchini|blomkål/i },
  { key: 'fruit', label: 'Frukt', icon: 'fa-solid fa-apple-whole', test: /äpple|apple|banan|apelsin|bär|bar|frukt|päron|paron|avokado|citron|lime/i },
  { key: 'dairy', label: 'Mejeri', icon: 'fa-solid fa-cheese', test: /yoghurt|mjölk|mjolk|ost|grädde|gradde|kvarg|fil|keso|smör|smor/i },
  { key: 'oils', label: 'Oljor', icon: 'fa-solid fa-droplet', test: /olja|olivolja|rapsolja|fett|majonnäs|majonnas|margarin/i },
  { key: 'nuts', label: 'Nötter', icon: 'fa-solid fa-seedling', test: /mandel|nöt|not|jordnöt|jordnot|pistage|cashew|valnöt|valnot|frö|fro|chia|sesam/i },
  { key: 'grain', label: 'Spannmål', icon: 'fa-solid fa-wheat-awn', test: /bröd|brod|pasta|ris|havre|vete|mjöl|mjol|gryn|couscous/i }
];

function getFoodVisual(food, groupName = '') {
  const haystack = `${food?.namn || ''} ${groupName || ''}`.toLowerCase();
  return FOOD_VISUAL_CATEGORIES.find(category => category.test.test(haystack))
    || { key: 'general', label: 'Livsmedel', icon: 'fa-solid fa-utensils' };
}

function foodVisualHtml(food, groupName) {
  const visual = getFoodVisual(food, groupName);
  const imageSrc = FOOD_IMAGE_OVERRIDES.get(food.id) || FOOD_IMAGE_OVERRIDES.get(String(food.id));
  const imageHtml = imageSrc
    ? `<img src="${imageSrc}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true; this.parentElement.classList.add('image-failed');">`
    : '';

  return `
    <div class="food-visual food-visual--${visual.key}" aria-hidden="true">
      <span class="food-visual-icon"><i class="${visual.icon}" aria-hidden="true"></i></span>
      <span class="food-visual-label">${visual.label}</span>
      ${imageHtml}
    </div>
  `;
}

async function renderFoodCardsAppend(data, version = null, signal = null) {
  const cardsRoot = document.getElementById('resultsCards') || nutritionOutput;
  const cardsWrap = document.getElementById('resultsCards');
  if (cardsWrap && cardsWrap.hasAttribute('hidden')) cardsWrap.removeAttribute('hidden');

  let shownInChunk = 0;
  // Skelettkort
  for (const food of data) {
    const card = document.createElement("div");
    card.className = "food-card";
    card.id = `food-${food.id}`;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    card.innerHTML = `
      <div class="food-visual food-visual--loading" aria-hidden="true">
        <span class="food-visual-icon"><i class="fa-solid fa-utensils" aria-hidden="true"></i></span>
        <span class="food-visual-label">Hämtar data</span>
      </div>
      <div class="food-card-body">
        <h3>${food.namn}</h3>
        <p class="loading">Laddar näringsvärden...</p>
      </div>
    `;
    if (lastSearchTerm && food.namn.toLowerCase() === lastSearchTerm) {
      card.classList.add("highlight");
    }
    cardsRoot.appendChild(card);
  }

  // Hjälpare för klassificering (samma som hos dig)
  const fetchClassificationWithSignal = async (id, s) => {
    const url = `https://dataportal.livsmedelsverket.se/livsmedel/api/v1/livsmedel/${id}/klassificeringar?sprak=1`;
    const res = await fetch(url, s ? { signal: s } : undefined);
    const data = await res.json();
    return (data && data.length > 0) ? data[0].namn : "Ingen klassificering tillgänglig";
  };

  // Fyll korten
  await Promise.all(data.map(async (food) => {
    const nutritionUrl = `https://dataportal.livsmedelsverket.se/livsmedel/api/v1/livsmedel/${food.id}/naringsvarden?sprak=1`;
    try {
        const nutritionData = nutritionCache.get(food.id)
        ?? await fetch(nutritionUrl, signal ? { signal } : undefined).then(r => r.json());
        nutritionCache.set(food.id, nutritionData);

      if (version !== null && version !== currentSearchVersion) return;

      const getEnergyKcal = () => {
        const item = nutritionData.find(n =>
          n.namn.toLowerCase().includes("energi") &&
          n.enhet && n.enhet.toLowerCase().includes("kcal")
        );
        return item ? item.varde : 0;
      };

      // skapa "find" för just detta livsmedels nutritionData
      const find = makeFinder(nutritionData);

      // Normaliserad karta med svenska alias (utökad lite för robusthet)
      const norm = {
        energy_kcal:      find(['energi (kcal)']),
        energy_kj:        find(['energi (kj)']),
        carbs_g:          find(['kolhydrater, tillgängliga','kolhydrater','kolhydrat']),
        sugars_g:         find(['sockerarter, totalt','sockerarter','socker']),
        free_sugar_g:     find(['fritt socker']),
        added_sugar_g:    find(['tillsatt socker']),
        // Livsmedelsverket använder ofta "Fibrer" eller "Kostfiber"
        fiber_g:          find(['fibrer','kostfiber','fiber']),
        fat_g:            find(['fett, totalt','fett totalt','fett (g)']),
        fat_saturated_g:  find(['summa mättade fettsyror','summa mättade']),
        fat_mono_g:       find(['summa enkelomättade fettsyror','summa enkelomättade']),
        fat_poly_g:       find(['summa fleromättade fettsyror','summa fleromättade']),
        protein_g:        find(['protein']),
        salt_g:           find(['salt, nacl']),
        sodium_mg:        find(['natrium, na']),
        cholesterol_mg:   find(['kolesterol']),
        water_g:          find(['vatten']),
        alcohol_g:        find(['alkohol']),
      };

      // Kärnvärden (med fallback för fett)
      const energiKcal  = norm.energy_kcal?.value ?? getEnergyKcal();
      const kolhydrater = norm.carbs_g?.value ?? 0;

      let fett = norm.fat_g?.value;
      if (!Number.isFinite(fett)) {
        const parts = [
          norm.fat_saturated_g?.value,
          norm.fat_mono_g?.value,
          norm.fat_poly_g?.value
        ].filter(Number.isFinite);
        if (parts.length) fett = +(parts.reduce((a,b)=>a+b,0).toFixed(1));
      }
      fett = Number.isFinite(fett) ? fett : 0;

      const protein = norm.protein_g?.value ?? 0;
      const fiber   = norm.fiber_g?.value ?? null;
      const sugar   = norm.sugars_g?.value ?? null;

      // ——— härledda värden som filter behöver ———
      const salt_g = norm.salt_g?.value ?? (norm.sodium_mg ? (norm.sodium_mg.value / 1000) * 2.5 : null); // Na mg → salt g
      const satFat_g = norm.fat_saturated_g?.value ?? null;
      const netCarbs_g = (Number.isFinite(kolhydrater) && Number.isFinite(fiber))
        ? Math.max(0, +(kolhydrater - fiber).toFixed(1))
        : null;

      // Filtrera enligt valt filter
      const predicate = buildFilterPredicate(dietFilter.type || 'all');
      const pass = predicate({
        kcal: energiKcal,
        carbs: kolhydrater,
        fat: fett,
        protein: protein,
        fiber: fiber,
        sugar: sugar,
        salt:  salt_g,
        satFat: satFat_g,
        netCarbs: netCarbs_g
      });
      if (!pass) {
        document.getElementById(`food-${food.id}`)?.remove();
        return;
      }
      shownInChunk++;

      const groupName = classCache.get(food.id)
      ?? await fetchClassificationWithSignal(food.id, signal);
      classCache.set(food.id, groupName);


      const addedSugar_g = norm.added_sugar_g?.value ?? null;
      const freeSugar_g  = norm.free_sugar_g?.value  ?? null;
      // välj “tillsatt socker” först, annars fritt/total
      const sugarLabel = norm.added_sugar_g?.label ?? norm.free_sugar_g?.label ?? norm.sugars_g?.label;
      const sugarValue = addedSugar_g ?? freeSugar_g ?? norm.sugars_g?.value ?? null;

      const proteinPer100kcal = energiKcal > 0 ? +( (protein / (energiKcal / 100)).toFixed(1) ) : null;
      const cholesterol_mg = norm.cholesterol_mg?.value ?? null;

      // liten formatter
      const f1 = n => Number.isFinite(n) ? (Math.round(n * 10) / 10) : null;

      // ——— bygg chips ———
      const chips = [];
      if (Number.isFinite(fiber))         chips.push(`<span class="chip">${norm.fiber_g?.label ?? 'Fibrer'}: ${f1(fiber)} g</span>`);
      if (Number.isFinite(sugarValue))    chips.push(`<span class="chip">${sugarLabel ?? 'Socker'}: ${f1(sugarValue)} g</span>`);
      if (Number.isFinite(salt_g))        chips.push(`<span class="chip">Salt: ${f1(salt_g)} g</span>`);
      if (Number.isFinite(satFat_g))      chips.push(`<span class="chip">Mättat fett: ${f1(satFat_g)} g</span>`);
      if (Number.isFinite(netCarbs_g))    chips.push(`<span class="chip">Netto-kolhydrater: ${f1(netCarbs_g)} g</span>`);
      if (Number.isFinite(proteinPer100kcal)) chips.push(`<span class="chip">Protein/100 kcal: ${f1(proteinPer100kcal)} g</span>`);
      if (Number.isFinite(cholesterol_mg))    chips.push(`<span class="chip">Kolesterol: ${Math.round(cholesterol_mg)} mg</span>`);

      // (valfritt) begränsa hur många som syns för att undvika “chip-sallad”
      const extrasHtml = chips.length ? `<div class="extras">${chips.slice(0, 4).join('')}</div>` : '';



      const card = document.getElementById(`food-${food.id}`);
      if (!card) return;
     
      card.innerHTML = `
        ${foodVisualHtml(food, groupName)}
        <div class="food-card-body">
          <div class="food-card-head">
            <h3>${food.namn} <small class="per100">per 100 g</small></h3>
            <span class="energy-pill">${energiKcal} kcal</span>
          </div>
          <p class="food-group">${groupName}</p>
          <dl class="macro-grid">
            <div>
              <dt>Protein</dt>
              <dd>${protein} g</dd>
            </div>
            <div>
              <dt>Fett</dt>
              <dd>${fett} g</dd>
            </div>
            <div>
              <dt>Kolhydrater</dt>
              <dd>${kolhydrater} g</dd>
            </div>
          </dl>
          ${extrasHtml}
        </div>
      `;

      if (lastSearchTerm && food.namn.toLowerCase() === lastSearchTerm) {
        card.classList.add("highlight");
        setTimeout(() => card.classList.remove("highlight"), 1800);
      }

      // Samla allt vi vill visa/beräkna i modalen (per 100 g)
      const detail = {
        energy_kcal:  energiKcal,
        carbs_g:      kolhydrater,
        fat_g:        fett,
        protein_g:    protein,
        fiber_g:      fiber,
        sugar_g:      sugarValue,
        sugar_label:  sugarLabel,
        salt_g:       salt_g,
        satFat_g:     satFat_g,
        netCarbs_g:   netCarbs_g
      };

      // Öppna modalen med objektet istället för 6 separata parametrar
      const openModal = () => showFoodModal(food, groupName, detail);
      card.addEventListener("click", openModal);

      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openModal(); }
      });

    } catch (err) {
      if (err.name === "AbortError") return;
      if (version !== null && version !== currentSearchVersion) return;
      const card = document.getElementById(`food-${food.id}`);
      if (card) {
        const loading = card.querySelector(".loading");
        if (loading) loading.textContent = "Kunde inte hämta näringsvärden.";
      }
    }
  }));
  return shownInChunk;
}

function addFood(id, namn, energiKcal, kolhydrater, fett, protein, quantity = null, extras = {}) {
  const qty = quantity !== null ? quantity : (parseInt(document.getElementById("quantity" + id).value, 10) || 100);

  const existingItem = selectedFoods.find(item => item.id === id);

  if (existingItem) {
    existingItem.quantity += qty;
  } else {
    selectedFoods.push({
      id, name: namn, quantity: qty,
      energiKcal, kolhydrater, fett, protein,
      // nya fält (kan vara null)
      fiber:    extras.fiber ?? null,
      sugar:    extras.sugar ?? null,
      sugar_label: extras.sugar_label ?? null,
      salt:     extras.salt ?? null,
      satFat:   extras.satFat ?? null,
      netCarbs: extras.netCarbs ?? null,
      groupName: extras.groupName ?? null 
    });
  }
  updateDrawerCount();
  updateSelectedFoodsList();
  adjustSelectedListHeight();
  updateSummary();
}

// =================================
// SELECTED FOODS
// =================================

function updateSelectedFoodsList() {
    foodList.innerHTML = "";

    for (let i = 0; i < selectedFoods.length; i++) {
        const item = selectedFoods[i];


        const maxLength = 35; // Max längd för namn i listan
        let trimmedName = item.name.length > maxLength
            ? item.name.substring(0, maxLength - 3) + "..."
            : item.name;

        const sliderMax = Math.max(DEFAULT_SLIDER_MAX, item.quantity);

    foodList.innerHTML += `
      <li class="food-list-item">
        <input
          type="range" min="0" max="${sliderMax}" step="10"
          value="${item.quantity}" class="quantity-slider"
          oninput="onSlider(${i}, this)"
        >
        <input
          type="number" min="0" step="1"
          value="${item.quantity}" class="quantity-input"
          oninput="onNumber(${i}, this)"
        >
        <button
          class="food-amount as-link" type="button"
          onclick="editFood(${i})" title="Redigera"
        >
          <span class="qty">${item.quantity} g</span>
          <b class="name">${trimmedName}</b>
        </button>
        <button
          class="adjust-button remove"
          onclick="removeFood(${i})" title="Ta bort"
          aria-label="Ta bort ${trimmedName}"
        >
          <i class="fa-solid fa-trash"></i>
        </button>
      </li>`;
    }
    updateDrawerCount();
    updateSummary();
}

function removeFood(index) {
    selectedFoods.splice(index, 1);
    updateSelectedFoodsList();
    adjustSelectedListHeight();
}

function increaseQuantity(index) {
    selectedFoods[index].quantity += 10;
    updateSelectedFoodsList();
    adjustSelectedListHeight();
}

function decreaseQuantity(index) {
    selectedFoods[index].quantity -= 10;
    if (selectedFoods[index].quantity <= 0) {
        selectedFoods.splice(index, 1);
    }
    updateSelectedFoodsList();
    adjustSelectedListHeight();
}

// =================================
// SUMMARY
// =================================

function setSummaryMetric(id, label, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
}

function updateSummary() {
  // Totals
  let totalEnergy = 0, totalCarbs = 0, totalFat = 0, totalProtein = 0;
  let totalFiber = 0, totalSugar = 0, totalSalt = 0, totalSatFat = 0, totalNetCarbs = 0;

  for (const item of selectedFoods) {
    const f = (item.quantity || 0) / 100;

    totalEnergy  += (item.energiKcal   || 0) * f;
    totalCarbs   += (item.kolhydrater  || 0) * f;
    totalFat     += (item.fett         || 0) * f;
    totalProtein += (item.protein      || 0) * f;

    if (Number.isFinite(item.fiber))     totalFiber    += item.fiber    * f;
    if (Number.isFinite(item.sugar))     totalSugar    += item.sugar    * f;
    if (Number.isFinite(item.salt))      totalSalt     += item.salt     * f;
    if (Number.isFinite(item.satFat))    totalSatFat   += item.satFat   * f;

    // Netto-kolhydrater: använd lagrat värde om det finns, annars carbs - fiber
    if (Number.isFinite(item.netCarbs)) {
      totalNetCarbs += item.netCarbs * f;
    } else if (Number.isFinite(item.kolhydrater) && Number.isFinite(item.fiber)) {
      totalNetCarbs += Math.max(0, item.kolhydrater - item.fiber) * f;
    }
  }

  const fmt1 = n => (Math.round(n * 10) / 10).toFixed(1);

  setSummaryMetric("totalEnergy", "Energi", `${fmt1(totalEnergy)} kcal`);
  setSummaryMetric("totalCarbs", "Kolhydrater", `${fmt1(totalCarbs)} g`);
  setSummaryMetric("totalFat", "Fett", `${fmt1(totalFat)} g`);
  setSummaryMetric("totalProtein", "Protein", `${fmt1(totalProtein)} g`);

  // Kommatecken-separerad rad med extra-summeringar
  const parts = [];
  if (totalFiber > 0)     parts.push(`Fiber: ${fmt1(totalFiber)} g`);
  if (totalSugar > 0)     parts.push(`Socker: ${fmt1(totalSugar)} g`);
  if (totalSalt > 0)      parts.push(`Salt: ${fmt1(totalSalt)} g`);
  if (totalSatFat > 0)    parts.push(`Mättat fett: ${fmt1(totalSatFat)} g`);
  if (totalNetCarbs > 0)  parts.push(`Netto-kolhydrater: ${fmt1(totalNetCarbs)} g`);

  let metaEl = document.getElementById("summaryMeta");
  if (!metaEl) {
    metaEl = document.createElement("p");
    metaEl.id = "summaryMeta";
    metaEl.className = "summary-meta";
    document.getElementById("summary").appendChild(metaEl);
  }
  metaEl.textContent = parts.join(', ');

  // Håller höjder i schack på mobil/desktop
  adjustSelectedListHeight();
  updateDrawerCount();
}

function syncRow(index, qty, numberEl, sliderEl, labelEl) {
  // 1) Normalisera och spara
  const q = Math.max(0, isNaN(qty) ? 0 : Math.round(qty));
  selectedFoods[index].quantity = q;

  // 2) Håll kontrollerna i synk
  if (numberEl && numberEl.value != q) numberEl.value = q;
  if (sliderEl) {
    const max = parseInt(sliderEl.max, 10) || 0;
    if (q > max) sliderEl.max = q;   // låt slidern “växa” med värdet
    if (sliderEl.value != q) sliderEl.value = q;
  }

  // 3) Uppdatera etiketten
  const name = selectedFoods[index].name;
  const maxLength = 35;
  const trimmedName = name.length > maxLength ? name.substring(0, maxLength - 3) + "..." : name;
  if (labelEl) {
    const qtyEl = labelEl.querySelector(".qty");
    const nameEl = labelEl.querySelector(".name");
    if (qtyEl && nameEl) {
      qtyEl.textContent = `${q} g`;
      nameEl.textContent = trimmedName;
    } else {
      labelEl.textContent = `${q} g ${trimmedName}`;
    }
  }

  // 4) Uppdatera summeringen direkt
  updateSummary();
}

function onSlider(index, sliderEl) {
  const li = sliderEl.closest("li");
  const numberEl = li.querySelector(".quantity-input");
  const labelEl  = li.querySelector(".food-amount");
  syncRow(index, parseInt(sliderEl.value, 10), numberEl, sliderEl, labelEl);
}

function onNumber(index, numberEl) {
  const li = numberEl.closest("li");
  const sliderEl = li.querySelector(".quantity-slider");
  const labelEl  = li.querySelector(".food-amount");
  syncRow(index, parseInt(numberEl.value, 10), numberEl, sliderEl, labelEl);
}

window.editFood = function(index){
  const it = selectedFoods[index];
  if(!it) return;

  // Bygg “food” och “detail” utifrån befintliga per-100g-värden du redan sparar
  const food   = { id: it.id, namn: it.name };
  const group  = it.groupName || "(okänd grupp)";

  const d = {
    energy_kcal: it.energiKcal ?? 0,
    carbs_g:     it.kolhydrater ?? 0,
    fat_g:       it.fett ?? 0,
    protein_g:   it.protein ?? 0,
    fiber_g:     Number.isFinite(it.fiber) ? it.fiber : null,
    sugar_g:     Number.isFinite(it.sugar) ? it.sugar : null,
    sugar_label: it.sugar_label ?? null,
    salt_g:      Number.isFinite(it.salt) ? it.salt : null,
    satFat_g:    Number.isFinite(it.satFat) ? it.satFat : null,
    netCarbs_g:  Number.isFinite(it.netCarbs) ? it.netCarbs : null
  };

  showFoodModal(food, group, d, { mode: "edit", editIndex: index, presetQty: it.quantity });
};

// =================================
// MODAL
// =================================

function showFoodModal(food, group, d, options = {}) {
  const modal = document.getElementById("foodModal");
  const body  = document.getElementById("modalBody");
  const isEdit = options.mode === "edit";
  const presetQty = Number.isFinite(options.presetQty) ? options.presetQty : 100;

  // === Bygg HTML-innehållet ===
  const extraRows = [];
  if (Number.isFinite(d.fiber_g))     extraRows.push(`<li class="extra">Fiber: <strong><span id="calcFiber">0</span> g</strong></li>`);
  if (Number.isFinite(d.sugar_g))     extraRows.push(`<li class="extra">${d.sugar_label ?? 'Socker'}: <strong><span id="calcSugar">0</span> g</strong></li>`);
  if (Number.isFinite(d.salt_g))      extraRows.push(`<li class="extra">Salt: <strong><span id="calcSalt">0</span> g</strong></li>`);
  if (Number.isFinite(d.satFat_g))    extraRows.push(`<li class="extra">Mättat fett: <strong><span id="calcSatFat">0</span> g</strong></li>`);
  if (Number.isFinite(d.netCarbs_g))  extraRows.push(`<li class="extra">Netto-kolhydrater: <strong><span id="calcNetCarbs">0</span> g</strong></li>`);

  const extrasHtml = extraRows.length
    ? `<details class="nutr-extras"><summary>Fler näringsvärden</summary><ul class="modal-extras">${extraRows.join('')}</ul></details>`
    : '';

  const lvUrl = lvFoodUrl(food.id);

  body.innerHTML = `
    <h2>${food.namn}</h2>
    <p><strong>Grupp:</strong> ${group}</p>

    <p class="per100">
      <em>Per 100 g:</em>
      Energi: ${d.energy_kcal} kcal · Kolhydrater: ${d.carbs_g} g · Fett: ${d.fat_g} g · Protein: ${d.protein_g} g
    </p>

    <h3 class="modal-section-title">Beräknat för <span id="modalQLabel">100</span> g</h3>
    <ul id="modalCalcList" class="modal-main">
      <li>Energi: <strong><span id="calcEnergy">0</span> kcal</strong></li>
      <li>Kolhydrater: <strong><span id="calcCarbs">0</span> g</strong></li>
      <li>Fett: <strong><span id="calcFat">0</span> g</strong></li>
      <li>Protein: <strong><span id="calcProtein">0</span> g</strong></li>
    </ul>
    ${extrasHtml}

    <div class="modal-qty">
      <label for="modalQuantityNumber">Gram:</label>
      <input type="number" id="modalQuantityNumber" class="quantity-input" min="0" step="1" value="100">
      <input type="range" id="modalQuantitySlider" class="quantity-slider" min="0" step="10" max="${DEFAULT_SLIDER_MAX}" value="100">
    </div>
    <div class="modal-actions">
      <button id="modalAddBtn">${isEdit ? "Spara" : "Lägg till"}</button>
      <a class="btn-secondary external" href="${lvUrl}" target="_blank" rel="noopener">Visa hos Livsmedelsverket</a>
    </div>
    <p class="modal-source">
      Källa: Livsmedelsverkets Livsmedelsdatabas, version ${LMV_VERSION}.
    </p>
  `;

  // === Bindningar till input/sliders ===
  const num    = document.getElementById("modalQuantityNumber");
  const sld    = document.getElementById("modalQuantitySlider");
  const qLabel = document.getElementById("modalQLabel");

  const hardMax = parseInt(sld.max, 10) || DEFAULT_SLIDER_MAX;
  if (presetQty > hardMax) sld.max = String(presetQty);

  num.value = presetQty;
  sld.value = presetQty;

  const eEl = document.getElementById("calcEnergy");
  const cEl = document.getElementById("calcCarbs");
  const fEl = document.getElementById("calcFat");
  const pEl = document.getElementById("calcProtein");
  const fiEl = document.getElementById("calcFiber");
  const suEl = document.getElementById("calcSugar");
  const saEl = document.getElementById("calcSalt");
  const sfEl = document.getElementById("calcSatFat");
  const ncEl = document.getElementById("calcNetCarbs");

  const round1 = (n) => Math.round(n * 10) / 10;
  const updateCalc = (q) => {
    const val = Math.max(0, isNaN(q) ? 0 : Math.round(q));
    num.value = val;
    sld.value = val;
    qLabel.textContent = String(val);

    const f = val / 100;
    eEl.textContent = round1(d.energy_kcal  * f).toFixed(1);
    cEl.textContent = round1(d.carbs_g      * f).toFixed(1);
    fEl.textContent = round1(d.fat_g        * f).toFixed(1);
    pEl.textContent = round1(d.protein_g    * f).toFixed(1);
    if (fiEl) fiEl.textContent = round1(d.fiber_g * f).toFixed(1);
    if (suEl) suEl.textContent = round1(d.sugar_g * f).toFixed(1);
    if (saEl) saEl.textContent = round1(d.salt_g  * f).toFixed(1);
    if (sfEl) sfEl.textContent = round1(d.satFat_g * f).toFixed(1);
    if (ncEl) ncEl.textContent = round1(d.netCarbs_g * f).toFixed(1);
  };

  num.addEventListener("input", () => updateCalc(parseInt(num.value, 10) || 0));
  sld.addEventListener("input", () => updateCalc(parseInt(sld.value, 10) || 0));

  // === Add/Edit-knapp ===
  const btn = document.getElementById("modalAddBtn");
  if (isEdit) {
    btn.onclick = () => {
      const q = parseInt(num.value, 10) || 0;
      selectedFoods[options.editIndex].quantity = q;
      updateSelectedFoodsList();
      adjustSelectedListHeight();
      updateSummary();
      closeFoodModal();
    };
  } else {
    btn.onclick = () => {
      const q = parseInt(num.value, 10) || 0;
      addFood(
        food.id, food.namn,
        d.energy_kcal, d.carbs_g, d.fat_g, d.protein_g,
        q,
        {
          fiber: d.fiber_g, sugar: d.sugar_g, sugar_label: d.sugar_label,
          salt: d.salt_g, satFat: d.satFat_g, netCarbs: d.netCarbs_g,
          groupName: group
        }
      );
      closeFoodModal();
    };
  }

  // === Öppna modal ===
  modal.classList.add("open");
  modal.removeAttribute("hidden");
  modal.setAttribute("aria-hidden","false");
  modal.querySelector(".close").onclick = closeFoodModal;
  modal.addEventListener('click', onModalBackdropClick);
  modal.addEventListener('touchstart', onModalBackdropClick, { passive: true });
  const onEsc = (ev) => { if (ev.key === "Escape") closeFoodModal(); };
  document.addEventListener('keydown', onEsc);
  modal._onEsc = onEsc;

  // Initiera med rätt mängd
  updateCalc(presetQty);
}

function closeFoodModal() {
  const modal = document.getElementById("foodModal");
  if (!modal) return;

  modal.classList.remove('open');
  modal.setAttribute('hidden','');
  modal.setAttribute('aria-hidden','true');
  modal.removeEventListener('click', onModalBackdropClick);
  modal.removeEventListener('touchstart', onModalBackdropClick);

  if (modal._onEsc) {
    document.removeEventListener('keydown', modal._onEsc);
    delete modal._onEsc;
  }
  // Inga overflow-återställningar behövs, eftersom vi aldrig låste dem.
}

document.getElementById("clearListButton").addEventListener("click", function () {
    selectedFoods = [];
    updateSelectedFoodsList();
    adjustSelectedListHeight();
    updateSummary();
});

function adjustSelectedListHeight() {
  const list = document.getElementById("selectedFoodsList");
  const summary = document.getElementById("summary");
  const container = isMobile() ? drawerContent : document.querySelector(".main-right");
  if (!container || !list || !summary) return;

  const containerHeight = container.clientHeight || container.getBoundingClientRect().height;
  const summaryHeight   = summary.getBoundingClientRect().height;
  const headerHeight    = sidebarHeader ? (sidebarHeader.getBoundingClientRect().height || 0) : 0;

  if (isMobile()) {
    const hardCap = Math.max(0, containerHeight - summaryHeight - headerHeight - 20);
    const earlyCap = 200;
    const minUsableListHeight = selectedFoods.length ? 118 : 0;
    const maxListHeight = Math.min(earlyCap, Math.max(minUsableListHeight, hardCap));
    list.style.maxHeight = maxListHeight + "px";
    list.style.overflowY = "auto";
    return;
  }

  const gutter = 12; // liten luft
  const hardCap = Math.max(0, containerHeight - summaryHeight - headerHeight - gutter);
  const minUsableListHeight = selectedFoods.length ? 148 : 0;
  const maxListHeight = Math.max(minUsableListHeight, hardCap);
  list.style.maxHeight = (list.scrollHeight > maxListHeight ? maxListHeight : "none");
  list.style.overflowY = "auto";
}

// Scrolla för att ändra alla range-sliders (även de som skapas senare)
document.addEventListener('wheel', (e) => {
  const slider = e.target.closest('input[type="range"]');
  if (!slider) return;                 // ignorera allt som inte är ett range

  e.preventDefault();                  // stoppa sid-/panelscroll
  const min  = slider.min  ? Number(slider.min)  : 0;
  const max  = slider.max  ? Number(slider.max)  : 100;
  const step = slider.step ? Number(slider.step) : 1;

  // upp = öka, ned = minska
  const dir  = e.deltaY < 0 ? 1 : -1;
  const mult = e.shiftKey ? 10 : 1;   // håll Shift för stora steg (valfritt)

  const next = Math.max(min, Math.min(max, Number(slider.value) + dir * step * mult));
  if (next !== Number(slider.value)) {
    slider.value = next;
    // trigga din befintliga oninput-logik (onSlider)
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, { passive: false });

document.querySelectorAll(".quick-filters button").forEach(btn => {
  btn.addEventListener("click", () => {
    const filter = btn.dataset.filter;
    const select = document.getElementById("dietSelect");

    // 🔁 Klick på redan aktiv knapp → slå AV
    if (activeQuickFilter === filter) {
      activeQuickFilter = null;

      // reset UI
      btn.classList.remove("is-active");
      select.value = "alla";
      searchInput.value = "";

      // visa empty state igen
      showEmptyState();
      return;
    }

    // 🆕 Nytt filter → slå PÅ
    activeQuickFilter = filter;

    // rensa tidigare aktiva knappar
    document.querySelectorAll(".quick-filters button")
      .forEach(b => b.classList.remove("is-active"));

    btn.classList.add("is-active");

    changingFromQuickFilter = true;
    select.value = filter;
    select.dispatchEvent(new Event("change"));
    changingFromQuickFilter = false;
  });
});

function setActiveQuickFilter(value) {
  document.querySelectorAll(".quick-filters button")
    .forEach(b => b.classList.toggle(
      "is-active",
      b.dataset.filter === value
    ));
}
