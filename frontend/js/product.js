/* =====================================================================
   Product details page (product.html?id=1)
   ===================================================================== */

const productId = new URLSearchParams(location.search).get("id");
const productPath = `/api/products/${encodeURIComponent(productId || "")}`;

function renderProduct(p) {
  document.title = `${p.name} — Project Catalogue`;
  document.getElementById("product-detail").innerHTML = `
    <h1 class="detail-title">${escapeHtml(p.name)}</h1>
    <div class="detail-media">${productImageHtml(p)}</div>
    <p class="detail-desc">${escapeHtml(p.description || "No description available.")}</p>
    <dl class="detail-meta">
      <div><dt>Category</dt><dd>${p.category ? `<span class="tag">${escapeHtml(p.category)}</span>` : "—"}</dd></div>
      <div><dt>Price</dt><dd class="price price-lg">${formatPrice(p.price)}</dd></div>
      <div><dt>Product ID</dt><dd><code>${escapeHtml(p.id)}</code></dd></div>
    </dl>`;
}

function renderCacheCard(meta) {
  const body = document.getElementById("cache-card-body");
  if (!meta || !meta.cache) {
    body.innerHTML = `<p class="muted">No cache information for this response.</p>`;
    return;
  }
  const cls = meta.cache === "HIT" ? "hit" : "miss";
  body.innerHTML = `
    <div class="cache-status ${cls}"><span class="dot pulse"></span>CACHE ${escapeHtml(meta.cache)}</div>
    <dl class="cache-meta">
      <div><dt>Response Time</dt><dd class="big">${formatMs(meta.serverTime)}</dd></div>
      <div><dt>Data Source</dt><dd>${dataSourceLabel(meta.source)}</dd></div>
      <div><dt>Redis Key</dt><dd><code>product:${escapeHtml(productId)}</code></dd></div>
      <div><dt>Browser Round Trip</dt><dd>${formatMs(meta.roundTrip)}</dd></div>
    </dl>`;
}

/**
 * Compare MISS vs HIT only once this visit has both: the current request
 * must be a HIT, paired with the MISS from this visit that cached it.
 */
function renderPerf(meta) {
  const container = document.getElementById("perf-demo");
  if (!meta || !meta.cache) {
    renderPerfComparison(container, null, "No cache information for this request.");
    return;
  }
  if (meta.cache === "MISS") {
    renderPerfComparison(container, null,
      "This request was a MISS, so the product is now stored in Redis. Click “Fetch again” to get a HIT and compare the two.");
    return;
  }
  renderPerfComparison(container, RequestLog.comparison(productPath),
    "This product was already in Redis before this visit, so there is no MISS to compare with. Wait for the key to expire, or use “Run test” in the Cache Monitor with “Clear the Redis cache first” ticked.");
}

async function loadProduct() {
  const detail = document.getElementById("product-detail");
  const button = document.getElementById("refetch");

  if (!productId) {
    detail.innerHTML = stateHtml("error", "Product not found.");
    renderCacheCard(null);
    button.hidden = true;
    return;
  }

  button.disabled = true;
  detail.innerHTML = stateHtml("loading", "Loading product...");
  let meta = null;
  try {
    const result = await Api.get(productPath);
    meta = result.meta;
    renderProduct(result.data);
    renderCacheCard(meta);
  } catch (err) {
    meta = err.meta;
    const notFound = err.status === 404 || err.status === 400;
    detail.innerHTML = stateHtml("error", notFound ? "Product not found." : errorMessage(err));
    renderCacheCard(meta);
  } finally {
    button.disabled = false;
    renderPerf(meta);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("refetch").addEventListener("click", loadProduct);
  loadProduct();
});
