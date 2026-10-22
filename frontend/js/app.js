/* =====================================================================
   Project Catalogue — shared helpers + products page / cache monitor
   ===================================================================== */

const NETWORK_ERROR_MESSAGE =
  "Unable to connect to the server.<br>Please check whether the FastAPI backend is running.";

const DEFAULT_CATEGORIES = ["Mobile", "Audio", "Laptop", "Accessories"];

/* ---------------------------------------------------------------------
   API helper (fetch wrapper)
   Reads X-Cache / X-Response-Time / X-Data-Source from every response.
   --------------------------------------------------------------------- */
class ApiError extends Error {
  constructor(message, status, meta) {
    super(message);
    this.status = status;          // 0 = network error (backend not reachable)
    this.meta = meta || null;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

const Api = {
  async request(path, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } };
    if (init.body !== undefined && typeof init.body !== "string") {
      init.body = JSON.stringify(init.body);
      init.headers["Content-Type"] = "application/json";
    }

    const started = performance.now();
    let response;
    try {
      response = await fetch(API_BASE_URL + path, init);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new ApiError("Unable to connect to the server.", 0);
    }
    const roundTrip = performance.now() - started;

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const meta = {
      path,
      status: response.status,
      cache: response.headers.get("X-Cache"),                       // "HIT" | "MISS" | null
      source: response.headers.get("X-Data-Source"),                // "redis" | "supabase" | "supabase-only"
      serverTime: parseFloat(response.headers.get("X-Response-Time")), // ms measured by FastAPI
      roundTrip,                                                    // ms measured by the browser
      at: Date.now(),
    };
    if (meta.cache) RequestLog.add(meta);

    if (!response.ok) {
      throw new ApiError((data && data.error) || `Request failed (${response.status})`, response.status, meta);
    }
    return { data, meta };
  },

  get(path, options) {
    return this.request(path, { ...options, method: "GET" });
  },
  post(path, body) {
    return this.request(path, { method: "POST", body });
  },
  put(path, body) {
    return this.request(path, { method: "PUT", body });
  },
  delete(path) {
    return this.request(path, { method: "DELETE" });
  },
};

/* ---------------------------------------------------------------------
   Request log — real measurements of cached GET requests, kept for this
   visit only (sessionStorage: survives a refresh, cleared with the tab)
   so the performance comparison never shows timings from an old visit.
   --------------------------------------------------------------------- */
const RequestLog = {
  KEY: "pc_request_log",
  MAX: 60,

  all() {
    try {
      return JSON.parse(sessionStorage.getItem(this.KEY)) || [];
    } catch {
      return [];
    }
  },

  add(entry) {
    const log = this.all();
    log.push({
      path: entry.path,
      cache: entry.cache,
      source: entry.source,
      serverTime: entry.serverTime,
      roundTrip: entry.roundTrip,
      at: entry.at,
    });
    try {
      sessionStorage.setItem(this.KEY, JSON.stringify(log.slice(-this.MAX)));
    } catch {
      /* storage unavailable — comparison simply won't persist */
    }
  },

  /** Latest HIT and the MISS that preceded it for the same request path. */
  comparison(pathFilter) {
    const log = this.all();
    for (let i = log.length - 1; i >= 0; i--) {
      const hit = log[i];
      if (hit.cache !== "HIT" || (pathFilter && hit.path !== pathFilter)) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (log[j].path === hit.path && log[j].cache === "MISS") {
          return { miss: log[j], hit };
        }
      }
    }
    return null;
  },
};

/* ---------------------------------------------------------------------
   Formatting + UI helpers
   --------------------------------------------------------------------- */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const priceFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) ? priceFormatter.format(n) : "—";
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} ms` : "—";
}

function dataSourceLabel(source) {
  if (source === "redis") return "Redis";
  if (source === "supabase") return "Supabase → Redis";
  if (source === "supabase-only") return "Supabase (Redis unavailable)";
  return "—";
}

function isSafeImageUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

const IMAGE_PLACEHOLDER =
  '<div class="img-placeholder"><span class="ph-logo">◈</span><span class="ph-text">IMAGE UNAVAILABLE</span></div>';

/** Product image with an onerror fallback to the themed placeholder. */
function productImageHtml(product) {
  if (!isSafeImageUrl(product.image_url)) return IMAGE_PLACEHOLDER;
  return `<img src="${escapeHtml(product.image_url.trim())}" alt="${escapeHtml(product.name)}"
           loading="lazy" onerror="handleImageError(this)">`;
}

function handleImageError(img) {
  img.onerror = null;
  img.outerHTML = IMAGE_PLACEHOLDER;
}

function stateHtml(type, message) {
  if (type === "loading") {
    return `<div class="state state-loading"><span class="spinner"></span><p>${message}</p></div>`;
  }
  const icon = type === "error" ? "⚠" : "◈";
  return `<div class="state state-${type}"><span class="state-icon">${icon}</span><p>${message}</p></div>`;
}

function errorMessage(err) {
  return err.isNetwork ? NETWORK_ERROR_MESSAGE : escapeHtml(err.message);
}

let toastTimer;
function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.className = "toast"), 3200);
}

/** Small HIT/MISS badge with the measured server time. */
function cacheStripHtml(meta, label) {
  const cls = meta.cache === "HIT" ? "hit" : "miss";
  return `<span class="cache-badge ${cls}"><span class="dot"></span>CACHE ${escapeHtml(meta.cache)}</span>
          <span class="strip-time">${formatMs(meta.serverTime)}</span>
          ${label ? `<code class="strip-key">${escapeHtml(label)}</code>` : ""}`;
}

/** "First request (MISS) → Second request (HIT)" using real measurements. */
function renderPerfComparison(container, pair, emptyMessage) {
  if (!container) return;
  if (!pair) {
    container.innerHTML = `<p class="muted small">${emptyMessage}</p>`;
    return;
  }
  const { miss, hit } = pair;
  let summary = "";
  if (miss.serverTime > 0 && hit.serverTime > 0) {
    const factor = miss.serverTime / hit.serverTime;
    summary = factor >= 1
      ? `Redis answered <strong>${factor.toFixed(1)}×</strong> faster (${formatMs(miss.serverTime - hit.serverTime)} saved).`
      : `This HIT was not faster this time (network jitter can do that) — try again.`;
  }
  container.innerHTML = `
    <div class="perf-step miss">
      <span class="perf-label">First Request</span>
      <span class="cache-badge miss"><span class="dot"></span>CACHE ${escapeHtml(miss.cache)}</span>
      <span class="perf-time">${formatMs(miss.serverTime)}</span>
      <span class="perf-source">${dataSourceLabel(miss.source)}</span>
    </div>
    <div class="perf-arrow">↓</div>
    <div class="perf-step hit">
      <span class="perf-label">Second Request</span>
      <span class="cache-badge hit"><span class="dot"></span>CACHE ${escapeHtml(hit.cache)}</span>
      <span class="perf-time">${formatMs(hit.serverTime)}</span>
      <span class="perf-source">${dataSourceLabel(hit.source)}</span>
    </div>
    <p class="perf-summary">${summary}</p>
    <p class="muted small">Request: <code>GET ${escapeHtml(hit.path)}</code> · server-side time from <code>X-Response-Time</code></p>`;
}

/* ---------------------------------------------------------------------
   Health check (header pill on every page)
   --------------------------------------------------------------------- */
async function fetchHealth() {
  try {
    const { data } = await Api.get("/api/health");
    return data;
  } catch {
    return null;
  }
}

function renderHeaderStatus(health) {
  const pill = document.getElementById("header-status");
  if (!pill) return;
  const label = pill.querySelector(".label");
  pill.classList.remove("ok", "warn", "down");
  if (!health) {
    pill.classList.add("down");
    label.textContent = "API offline";
  } else if (health.database === "connected" && health.redis === "connected") {
    pill.classList.add("ok");
    label.textContent = "All systems online";
  } else {
    pill.classList.add("warn");
    label.textContent = health.database !== "connected" ? "Database issue" : "Redis offline";
  }
}

function setActiveNav() {
  const page = document.body.dataset.page;
  const active = page === "admin" ? "admin" : location.hash === "#cache-monitor" ? "cache" : "products";
  document.querySelectorAll("[data-nav]").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === active);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  setActiveNav();
  window.addEventListener("hashchange", setActiveNav);
  const health = await fetchHealth();
  renderHeaderStatus(health);
  if (document.body.dataset.page === "products") renderSystemStatus(health);
});

/* =====================================================================
   PRODUCTS PAGE (index.html)
   ===================================================================== */
const catalogue = {
  category: "",
  search: "",
  controller: null,
  categories: new Set(DEFAULT_CATEGORIES),
};

function productCardHtml(p) {
  return `
    <a class="product-card" href="product.html?id=${encodeURIComponent(p.id)}">
      <div class="card-media">${productImageHtml(p)}</div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(p.name)}</h3>
        <p class="card-desc">${escapeHtml(p.description || "No description")}</p>
        ${p.category ? `<span class="tag">${escapeHtml(p.category)}</span>` : ""}
        <div class="card-foot">
          <span class="price">${formatPrice(p.price)}</span>
          <span class="card-link">View Details →</span>
        </div>
      </div>
    </a>`;
}

function renderFilters() {
  const box = document.getElementById("category-filters");
  const options = ["", ...catalogue.categories];
  box.innerHTML = options
    .map((c) => {
      const active = c === catalogue.category;
      return `<button type="button" class="filter-btn${active ? " active" : ""}" data-category="${escapeHtml(c)}"
                role="tab" aria-selected="${active}">${c ? escapeHtml(c) : "All"}</button>`;
    })
    .join("");
}

function currentListPath() {
  const params = new URLSearchParams();
  if (catalogue.category) params.set("category", catalogue.category);
  if (catalogue.search) params.set("search", catalogue.search);
  const qs = params.toString();
  return "/api/products" + (qs ? `?${qs}` : "");
}

function describeListKey() {
  const search = catalogue.search.toLowerCase().replace(/[^\w\s-]/g, " ").trim().replace(/\s+/g, " ");
  if (search && catalogue.category) return `products:search:${search}:category:${catalogue.category}`;
  if (search) return `products:search:${search}`;
  if (catalogue.category) return `products:category:${catalogue.category}`;
  return "products:all";
}

async function loadProducts() {
  const grid = document.getElementById("product-grid");
  const strip = document.getElementById("list-cache");

  if (catalogue.controller) catalogue.controller.abort();
  catalogue.controller = new AbortController();

  grid.innerHTML = stateHtml("loading", "Loading products...");

  try {
    const { data, meta } = await Api.get(currentListPath(), { signal: catalogue.controller.signal });
    strip.innerHTML = cacheStripHtml(meta, describeListKey());
    strip.hidden = false;

    // Learn any extra categories from the full list.
    if (!catalogue.category && !catalogue.search) {
      const before = catalogue.categories.size;
      data.products.forEach((p) => p.category && catalogue.categories.add(p.category));
      if (catalogue.categories.size !== before) renderFilters();
      fillPerfSelect(data.products);
    }

    grid.innerHTML = data.products.length
      ? data.products.map(productCardHtml).join("")
      : stateHtml("empty", "No products found.");

    loadCacheStats();
  } catch (err) {
    if (err.name === "AbortError") return;
    strip.hidden = true;
    grid.innerHTML = stateHtml("error", errorMessage(err));
  }
}

function initProductsPage() {
  renderFilters();

  document.getElementById("category-filters").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    catalogue.category = btn.dataset.category;
    renderFilters();
    loadProducts();
  });

  const input = document.getElementById("search-input");
  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const value = input.value.trim();
      if (value === catalogue.search) return;
      catalogue.search = value;
      loadProducts();
    }, 400);
  });
  document.getElementById("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(debounce);
    catalogue.search = input.value.trim();
    loadProducts();
  });

  loadProducts();
  initCacheMonitor();
}

/* =====================================================================
   CACHE MONITOR (index.html#cache-monitor)
   ===================================================================== */
let cachedKeys = [];
let keysFetchedAt = 0;

function renderSystemStatus(health) {
  const list = document.getElementById("system-status");
  if (!list) return;
  const rows = [
    ["API", health ? "ONLINE" : "OFFLINE", !!health],
    ["Database", health ? health.database.toUpperCase() : "UNKNOWN", health && health.database === "connected"],
    ["Redis", health ? health.redis.toUpperCase() : "UNKNOWN", health && health.redis === "connected"],
  ];
  list.innerHTML = rows
    .map(([name, value, ok]) => `
      <li class="${ok ? "ok" : "down"}">
        <span class="dot"></span><span class="status-name">${name}</span><span class="status-value">${value}</span>
      </li>`)
    .join("");
}

async function loadCacheStats() {
  if (!document.getElementById("stats-grid")) return;
  try {
    const { data } = await Api.get("/api/cache/stats");
    const values = {
      hits: data.hits,
      misses: data.misses,
      hit_rate: `${data.hit_rate}%`,
      cached_keys: data.cached_keys,
    };
    Object.entries(values).forEach(([k, v]) => {
      document.querySelector(`[data-stat="${k}"]`).textContent = v;
    });
    document.getElementById("ttl-info").textContent = `· TTL ${data.ttl}s`;
    cachedKeys = data.keys || [];
    keysFetchedAt = Date.now();
    renderKeys(data.redis === "connected");
  } catch (err) {
    document.querySelectorAll("[data-stat]").forEach((el) => (el.textContent = "—"));
    document.getElementById("keys-body").innerHTML =
      `<tr><td colspan="2" class="muted">${err.isNetwork ? "Backend unavailable." : escapeHtml(err.message)}</td></tr>`;
  }
  renderPerfComparison(
    document.getElementById("perf-demo"),
    RequestLog.comparison(),
    "No comparison yet. Open any product twice (or use the live test below) to see a real MISS vs HIT measurement."
  );
}

/** Render keys with a TTL that counts down locally between refreshes. */
function renderKeys(redisOk = true) {
  const body = document.getElementById("keys-body");
  if (!redisOk) {
    body.innerHTML = `<tr><td colspan="2" class="muted">Redis is unavailable — requests are served directly from Supabase.</td></tr>`;
    return;
  }
  const elapsed = Math.floor((Date.now() - keysFetchedAt) / 1000);
  const rows = cachedKeys
    .map((k) => ({ key: k.key, ttl: k.ttl < 0 ? k.ttl : k.ttl - elapsed }))
    .filter((k) => k.ttl < 0 || k.ttl > 0);
  body.innerHTML = rows.length
    ? rows.map((k) => `<tr><td><code>${escapeHtml(k.key)}</code></td>
                         <td class="ttl">${k.ttl < 0 ? "no expiry" : `${k.ttl}s`}</td></tr>`).join("")
    : `<tr><td colspan="2" class="muted">No keys cached right now. Load some products to populate Redis.</td></tr>`;
}

function fillPerfSelect(products) {
  const select = document.getElementById("perf-product");
  if (!select) return;
  const previous = select.value;
  select.innerHTML = products
    .map((p) => `<option value="${escapeHtml(p.id)}">#${escapeHtml(p.id)} — ${escapeHtml(p.name)}</option>`)
    .join("");
  if (previous) select.value = previous;
}

async function runLiveTest() {
  const select = document.getElementById("perf-product");
  const button = document.getElementById("run-test");
  const demo = document.getElementById("perf-demo");
  if (!select.value) {
    showToast("No products available to test.", "error");
    return;
  }

  button.disabled = true;
  demo.innerHTML = stateHtml("loading", "Running test...");
  try {
    if (document.getElementById("perf-flush").checked) await Api.post("/api/cache/clear");
    const path = `/api/products/${encodeURIComponent(select.value)}`;
    const first = await Api.get(path);
    const second = await Api.get(path);

    if (first.meta.cache === "MISS" && second.meta.cache === "HIT") {
      renderPerfComparison(demo, { miss: first.meta, hit: second.meta });
    } else {
      demo.innerHTML = `
        <p class="muted small">First request: <strong>${escapeHtml(first.meta.cache)}</strong> (${formatMs(first.meta.serverTime)}),
        second request: <strong>${escapeHtml(second.meta.cache)}</strong> (${formatMs(second.meta.serverTime)}).</p>
        <p class="muted small">${first.meta.cache === "HIT"
          ? "The product was already cached. Tick “Clear the Redis cache first” to force a MISS."
          : "Redis did not store the value — check the Redis status above."}</p>`;
    }
  } catch (err) {
    demo.innerHTML = stateHtml("error", errorMessage(err));
  } finally {
    button.disabled = false;
    loadCacheStats();
  }
}

async function flushCache() {
  if (!confirm("Delete all Project Catalogue keys from Redis?")) return;
  try {
    const { data } = await Api.post("/api/cache/clear");
    showToast(`Cache cleared (${data.invalidated_keys.length} keys removed)`, "success");
  } catch (err) {
    showToast(err.isNetwork ? "Backend unavailable" : err.message, "error");
  }
  loadCacheStats();
}

function initCacheMonitor() {
  document.getElementById("refresh-stats").addEventListener("click", async () => {
    loadCacheStats();
    const health = await fetchHealth();
    renderHeaderStatus(health);
    renderSystemStatus(health);
  });
  document.getElementById("run-test").addEventListener("click", runLiveTest);
  document.getElementById("flush-cache").addEventListener("click", flushCache);

  setInterval(() => renderKeys(), 1000);                       // local TTL countdown
  setInterval(() => !document.hidden && loadCacheStats(), 10000); // refresh from the server
}

if (document.body.dataset.page === "products") {
  document.addEventListener("DOMContentLoaded", initProductsPage);
}
