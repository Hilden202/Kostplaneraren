(function () {
  const FORMSPREE_ENDPOINT = "https://formspree.io/f/xykvpnzd";

  let modal = null;
  let lastFocus = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function detailsFromButton(button) {
    return {
      foodName: button.dataset.foodName || "",
      foodId: button.dataset.foodId || "",
      slug: button.dataset.slug || "",
      imageStatus: button.dataset.imageStatus || "",
      currentImageUrl: button.dataset.imageUrl || ""
    };
  }

  function ensureModal() {
    if (modal) return modal;

    modal = document.createElement("div");
    modal.className = "image-suggestion-modal";
    modal.setAttribute("hidden", "");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="image-suggestion-dialog" role="dialog" aria-modal="true" aria-labelledby="imageSuggestionTitle">
        <button class="image-suggestion-close" type="button" aria-label="Stäng">&times;</button>
        <form class="image-suggestion-form" action="${FORMSPREE_ENDPOINT}" method="POST">
          <div class="image-suggestion-heading">
            <p class="image-suggestion-kicker">Bildförslag</p>
            <h2 id="imageSuggestionTitle">Föreslå bild</h2>
            <p id="imageSuggestionIntro">Skicka en publik bildlänk som passar livsmedlet.</p>
          </div>

          <label>
            Livsmedel
            <input name="food_name" id="suggestFoodName" type="text" readonly>
          </label>

          <div class="image-suggestion-grid">
            <label>
              Livsmedels-ID
              <input name="food_id" id="suggestFoodId" type="text" readonly>
            </label>
            <label>
              Slug
              <input name="slug" id="suggestSlug" type="text" readonly>
            </label>
          </div>

          <label>
            Bildlänk
            <input name="image_url" id="suggestImageUrl" type="url" inputmode="url" autocomplete="url" placeholder="https://..." required>
          </label>

          <label>
            Kommentar <span class="optional">(valfritt)</span>
            <textarea name="comment" id="suggestComment" rows="3" placeholder="Varför bilden passar, källa eller beskärningsidé..."></textarea>
          </label>

          <p class="image-rights-note">
            Dela bara bilder du själv tagit eller har tillåtelse att använda.
          </p>

          <input name="image_status" id="suggestImageStatus" type="hidden">
          <input name="current_image_url" id="suggestCurrentImageUrl" type="hidden">
          <input name="page_url" id="suggestPageUrl" type="hidden">

          <div class="image-suggestion-actions">
            <button class="image-suggestion-submit" type="submit">Skicka</button>
            <button class="image-suggestion-cancel" type="button">Avbryt</button>
          </div>

          <p class="image-suggestion-status" aria-live="polite"></p>
        </form>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector(".image-suggestion-close").addEventListener("click", close);
    modal.querySelector(".image-suggestion-cancel").addEventListener("click", close);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    modal.querySelector("form").addEventListener("submit", submitSuggestion);

    return modal;
  }

  function setField(id, value) {
    const field = modal.querySelector(`#${id}`);
    if (field) field.value = value || "";
  }

  function open(details = {}) {
    ensureModal();

    const foodName = details.foodName || details.name || "";
    const foodId = details.foodId || details.id || "";
    const slug = details.slug || window.KostFoodImages?.foodSlug(foodName) || "";
    const currentImageUrl = details.currentImageUrl || details.imageUrl || "";
    const hasImage = details.imageStatus === "completed" || Boolean(currentImageUrl);
    const title = hasImage ? "Föreslå bättre bild" : "Föreslå bild";
    const intro = hasImage
      ? "Hittat en tydligare eller mer representativ bild? Skicka länken här."
      : "Det här livsmedlet saknar bild. Skicka gärna en publik bildlänk som passar.";

    modal.querySelector("#imageSuggestionTitle").textContent = title;
    modal.querySelector("#imageSuggestionIntro").textContent = intro;

    setField("suggestFoodName", foodName);
    setField("suggestFoodId", foodId);
    setField("suggestSlug", slug);
    setField("suggestImageUrl", "");
    setField("suggestComment", "");
    setField("suggestImageStatus", hasImage ? "completed" : "missing");
    setField("suggestCurrentImageUrl", currentImageUrl);
    setField("suggestPageUrl", window.location.href);

    const status = modal.querySelector(".image-suggestion-status");
    if (status) status.textContent = "";

    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.removeAttribute("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("image-suggestion-open");
    window.setTimeout(() => modal.querySelector("#suggestImageUrl")?.focus(), 0);
  }

  function close() {
    if (!modal) return;

    modal.setAttribute("hidden", "");
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("image-suggestion-open");
    lastFocus?.focus?.({ preventScroll: true });
    lastFocus = null;
  }

  async function submitSuggestion(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const status = form.querySelector(".image-suggestion-status");
    const submitButton = form.querySelector(".image-suggestion-submit");

    if (status) {
      status.classList.remove("is-error", "is-success");
      status.textContent = "Skickar bildförslag...";
    }
    if (submitButton) submitButton.disabled = true;

    try {
      const response = await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        body: new FormData(form),
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Formspree returned ${response.status}`);
      }

      if (status) {
        status.classList.add("is-success");
        status.textContent = "Tack! Bildförslaget har skickats.";
      }

      form.querySelector("#suggestImageUrl").value = "";
      form.querySelector("#suggestComment").value = "";
      window.setTimeout(close, 1100);
    } catch (error) {
      if (status) {
        status.classList.add("is-error");
        status.textContent = "Det gick inte att skicka just nu. Försök igen om en stund.";
      }
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const button = target?.closest("[data-suggest-image]");
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    open(detailsFromButton(button));
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hasAttribute("hidden")) {
      close();
    }
  });

  window.KostImageSuggestions = Object.freeze({
    open,
    close,
    escapeHtml
  });
}());
