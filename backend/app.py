"""
Project Catalogue API — FastAPI + Supabase + Redis (cache-aside pattern).

Run with:  uvicorn app:app --reload
"""

import logging
import math
import os
import re
import time

from fastapi import Body, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import cache_stats
import database
import redis_cache
from database import DatabaseError

logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("app")

app = FastAPI(title="Project Catalogue API")

# ---------------------------------------------------------------------------
# CORS: only the local frontend origins (VS Code Live Server / http.server).
# ---------------------------------------------------------------------------
ALLOWED_ORIGINS = ["http://localhost:5500", "http://127.0.0.1:5500"]
ALLOWED_ORIGINS += [o.strip() for o in os.getenv("FRONTEND_ORIGINS", "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
    # Without this the browser hides our custom headers from JavaScript.
    expose_headers=["X-Cache", "X-Response-Time", "X-Data-Source"],
)


@app.middleware("http")
async def add_response_time(request: Request, call_next):
    """Measure how long the server spent on each request."""
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    response.headers["X-Response-Time"] = f"{elapsed_ms:.2f}ms"
    return response


@app.exception_handler(RequestValidationError)
async def invalid_request_body(request: Request, exc: RequestValidationError):
    return JSONResponse({"error": "Request body must be a valid JSON object"}, status_code=400)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def error(message, status_code):
    return JSONResponse({"error": message}, status_code=status_code)


def cache_headers(cache_status, source):
    """
    X-Cache:       HIT or MISS
    X-Data-Source: redis     -> served from Redis
                   supabase  -> read from Supabase, then stored in Redis
                   supabase-only -> Redis unavailable, Supabase used directly
    """
    return {"X-Cache": cache_status, "X-Data-Source": source}


def parse_product_id(raw):
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def normalize_search(raw):
    """'  iPhone ' -> 'iphone'. Strips characters that could break the query."""
    if not raw:
        return ""
    cleaned = re.sub(r"[^\w\s-]", " ", raw.lower())
    return " ".join(cleaned.split())


def build_list_key(category, search):
    if search and category:
        return f"products:search:{search}:category:{category}"
    if search:
        return f"products:search:{search}"
    if category:
        return f"products:category:{category}"
    return "products:all"


def validate_product(payload):
    """Manual validation (no Pydantic). Returns (clean_data, error_message)."""
    if not isinstance(payload, dict):
        return None, "Request body must be a JSON object"

    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "Product name is required"
    name = name.strip()
    if len(name) > 100:
        return None, "Product name must be at most 100 characters"

    price = payload.get("price")
    if price is None or price == "":
        return None, "Price is required"
    if isinstance(price, bool):
        return None, "Price must be a valid number"
    try:
        price = float(price)
    except (TypeError, ValueError):
        return None, "Price must be a valid number"
    if not math.isfinite(price):
        return None, "Price must be a valid number"
    if price < 0:
        return None, "Price must be greater than or equal to 0"
    if price > 99999999.99:  # DECIMAL(10,2) limit
        return None, "Price is too large"
    price = round(price, 2)
    if price.is_integer():
        price = int(price)

    def optional_text(field, max_len=None):
        value = payload.get(field)
        if value is None:
            return None, None
        if not isinstance(value, str):
            return None, f"{field} must be text"
        value = value.strip()
        if max_len and len(value) > max_len:
            return None, f"{field} must be at most {max_len} characters"
        return (value or None), None

    category, err = optional_text("category", 50)
    if err:
        return None, err
    description, err = optional_text("description")
    if err:
        return None, err
    image_url, err = optional_text("image_url")
    if err:
        return None, err

    return {
        "name": name,
        "description": description,
        "price": price,
        "category": category,
        "image_url": image_url,
    }, None


def invalidate_product_caches(product_id=None, categories=()):
    """
    Remove cached data that may now be stale.

    - product:{id}               (the product itself)
    - products:all               (full list)
    - products:category:{cat}    (old and new category)
    - products:search:*          (any search could include the product; found with SCAN)
    """
    keys = ["products:all"] + [f"products:category:{c}" for c in categories if c]
    if product_id is not None:
        keys.insert(0, f"product:{product_id}")

    removed = redis_cache.delete_keys(keys)
    removed += redis_cache.delete_pattern("products:search:*")
    if removed:
        logger.info("Cache invalidated: %s", ", ".join(removed))
    return removed


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {
        "backend": "ok",
        "database": "connected" if database.ping() else "disconnected",
        "redis": "connected" if redis_cache.ping() else "disconnected",
    }


@app.get("/api/products")
def list_products(category: str | None = None, search: str | None = None):
    category = (category or "").strip() or None
    search = normalize_search(search) or None
    key = build_list_key(category, search)

    # 1. Check Redis
    cached, redis_ok = redis_cache.get_json(key)
    if cached is not None:
        cache_stats.record_hit()
        return JSONResponse(cached, headers=cache_headers("HIT", "redis"))

    # 2. Cache MISS -> Supabase
    cache_stats.record_miss()
    try:
        products = database.fetch_products(category=category, search=search)
    except DatabaseError:
        return error("Unable to retrieve products", 500)

    result = {"products": products, "count": len(products)}

    # 3. Store in Redis for next time
    stored = redis_ok and redis_cache.set_json(key, result)
    return JSONResponse(result, headers=cache_headers("MISS", "supabase" if stored else "supabase-only"))


@app.get("/api/products/{product_id}")
def get_product(product_id: str):
    pid = parse_product_id(product_id)
    if pid is None:
        return error("Invalid product ID", 400)

    key = f"product:{pid}"

    # 1. Check Redis
    cached, redis_ok = redis_cache.get_json(key)
    if cached is not None:
        # Cache HIT: Supabase is NOT queried.
        cache_stats.record_hit()
        return JSONResponse(cached, headers=cache_headers("HIT", "redis"))

    # 2. Cache MISS -> Supabase
    cache_stats.record_miss()
    try:
        product = database.fetch_product(pid)
    except DatabaseError:
        return error("Unable to retrieve product", 500)

    if product is None:
        return JSONResponse(
            {"error": "Product not found"},
            status_code=404,
            headers=cache_headers("MISS", "supabase-only"),
        )

    # 3. Store in Redis with TTL
    stored = redis_ok and redis_cache.set_json(key, product)
    return JSONResponse(product, headers=cache_headers("MISS", "supabase" if stored else "supabase-only"))


@app.post("/api/products")
def create_product(payload: dict = Body(...)):
    data, err = validate_product(payload)
    if err:
        return error(err, 400)

    try:
        product = database.insert_product(data)
    except DatabaseError:
        return error("Unable to create product", 500)
    if product is None:
        return error("Unable to create product", 500)

    removed = invalidate_product_caches(categories=[product.get("category")])
    return JSONResponse(
        {"message": "Product created", "product": product, "invalidated_keys": removed},
        status_code=201,
    )


@app.put("/api/products/{product_id}")
def edit_product(product_id: str, payload: dict = Body(...)):
    pid = parse_product_id(product_id)
    if pid is None:
        return error("Invalid product ID", 400)

    data, err = validate_product(payload)
    if err:
        return error(err, 400)

    try:
        # Read the current row from Supabase (not the cache) to know the old category.
        existing = database.fetch_product(pid)
        if existing is None:
            return error("Product not found", 404)
        product = database.update_product(pid, data)
    except DatabaseError:
        return error("Unable to update product", 500)
    if product is None:
        return error("Product not found", 404)

    removed = invalidate_product_caches(pid, [existing.get("category"), product.get("category")])
    return {"message": "Product updated", "product": product, "invalidated_keys": removed}


@app.delete("/api/products/{product_id}")
def remove_product(product_id: str):
    pid = parse_product_id(product_id)
    if pid is None:
        return error("Invalid product ID", 400)

    try:
        product = database.delete_product(pid)
    except DatabaseError:
        return error("Unable to delete product", 500)
    if product is None:
        return error("Product not found", 404)

    removed = invalidate_product_caches(pid, [product.get("category")])
    return {"message": "Product deleted", "product": product, "invalidated_keys": removed}


@app.get("/api/cache/stats")
def cache_statistics():
    keys, redis_ok = redis_cache.list_app_keys()
    stats = cache_stats.snapshot()
    stats.update(
        cached_keys=len(keys),
        ttl=redis_cache.CACHE_TTL,
        redis="connected" if redis_ok else "disconnected",
        keys=keys,
    )
    return stats


@app.post("/api/cache/clear")
def clear_cache():
    """Delete all of this app's keys from Redis (handy for demonstrating a MISS)."""
    if not redis_cache.ping():
        return error("Redis is unavailable", 503)
    removed = redis_cache.clear_app_keys()
    return {"message": "Cache cleared", "invalidated_keys": removed}
