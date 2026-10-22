/* =====================================================================
   Admin page — add / edit / delete products
   ===================================================================== */

let adminProducts = [];

const form = document.getElementById("product-form");
const fields = ["name", "description", "price", "category", "image_url"];

function rowHtml(p) {
  return `
    <tr>
      <td>
        <a href="product.html?id=${encodeURIComponent(p.id)}" class="row-name">${escapeHtml(p.name)}</a>
        <span class="row-id">#${escapeHtml(p.id)}</span>
      </td>
      <td class="price">${formatPrice(p.price)}</td>
      <td>${p.category ? `<span class="tag">${escapeHtml(p.category)}</span>` : "—"}</td>
      <td class="actions-col">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${escapeHtml(p.id)}">Edit</button>
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(p.id)}">Delete</button>
      </td>
    </tr>`;
}

async function loadAdminProducts() {
  const rows = document.getElementById("product-rows");
  const strip = document.getElementById("list-cache");
  rows.innerHTML = `<tr><td colspan="4">${stateHtml("loading", "Loading products...")}</td></tr>`;
  try {
    const { data, meta } = await Api.get("/api/products");
    adminProducts = data.products;
    strip.innerHTML = cacheStripHtml(meta, "products:all");
    strip.hidden = false;
    rows.innerHTML = adminProducts.length
      ? adminProducts.map(rowHtml).join("")
      : `<tr><td colspan="4">${stateHtml("empty", "No products found.")}</td></tr>`;
  } catch (err) {
    strip.hidden = true;
    rows.innerHTML = `<tr><td colspan="4">${stateHtml("error", errorMessage(err))}</td></tr>`;
  }
}

function showFormError(message) {
  const box = document.getElementById("form-error");
  box.textContent = message || "";
  box.hidden = !message;
}

function showInvalidation(action, keys) {
  const box = document.getElementById("invalidation");
  box.hidden = false;
  box.innerHTML = `
    <span class="inv-title">Redis invalidation after ${escapeHtml(action)}</span>
    ${keys.length
      ? keys.map((k) => `<code>DEL ${escapeHtml(k)}</code>`).join("")
      : `<span class="muted small">No affected keys were cached (or Redis is unavailable).</span>`}`;
}

function readForm() {
  const value = (id) => document.getElementById(id).value.trim();
  return {
    name: value("name"),
    description: value("description"),
    price: value("price") === "" ? null : Number(value("price")),
    category: value("category"),
    image_url: value("image_url"),
  };
}

/** Quick client-side checks; the backend validates again and is authoritative. */
function validateForm(data) {
  if (!data.name) return "Product name is required";
  if (data.name.length > 100) return "Product name must be at most 100 characters";
  if (data.price === null) return "Price is required";
  if (!Number.isFinite(data.price)) return "Price must be a valid number";
  if (data.price < 0) return "Price must be greater than or equal to 0";
  if (data.category.length > 50) return "Category must be at most 50 characters";
  return null;
}

function startEdit(id) {
  const p = adminProducts.find((x) => String(x.id) === String(id));
  if (!p) return;
  document.getElementById("product-id").value = p.id;
  fields.forEach((f) => (document.getElementById(f).value = p[f] ?? ""));
  document.getElementById("form-title").textContent = `Edit Product #${p.id}`;
  document.getElementById("submit-btn").textContent = "Update Product";
  document.getElementById("cancel-edit").hidden = false;
  showFormError("");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("name").focus();
}

function resetForm() {
  form.reset();
  document.getElementById("product-id").value = "";
  document.getElementById("form-title").textContent = "Add Product";
  document.getElementById("submit-btn").textContent = "Add Product";
  document.getElementById("cancel-edit").hidden = true;
  showFormError("");
}

async function submitForm(e) {
  e.preventDefault();
  const data = readForm();
  const problem = validateForm(data);
  if (problem) {
    showFormError(problem);
    return;
  }
  showFormError("");

  const id = document.getElementById("product-id").value;
  const button = document.getElementById("submit-btn");
  button.disabled = true;
  try {
    const { data: result } = id
      ? await Api.put(`/api/products/${encodeURIComponent(id)}`, data)
      : await Api.post("/api/products", data);
    showToast(id ? "Product updated" : "Product added", "success");
    showInvalidation(id ? "update" : "create", result.invalidated_keys || []);
    resetForm();
    loadAdminProducts();
  } catch (err) {
    showFormError(err.isNetwork ? "Unable to connect to the server. Please check whether the FastAPI backend is running." : err.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteProduct(id) {
  const p = adminProducts.find((x) => String(x.id) === String(id));
  if (!confirm(`Delete "${p ? p.name : `#${id}`}"? This cannot be undone.`)) return;
  try {
    const { data } = await Api.delete(`/api/products/${encodeURIComponent(id)}`);
    showToast("Product deleted", "success");
    showInvalidation("delete", data.invalidated_keys || []);
    if (document.getElementById("product-id").value === String(id)) resetForm();
    loadAdminProducts();
  } catch (err) {
    showToast(err.isNetwork ? "Backend unavailable" : err.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  form.addEventListener("submit", submitForm);
  document.getElementById("cancel-edit").addEventListener("click", resetForm);
  document.getElementById("product-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "edit") startEdit(btn.dataset.id);
    else deleteProduct(btn.dataset.id);
  });
  loadAdminProducts();
});
