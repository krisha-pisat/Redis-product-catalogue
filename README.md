# ◈ Project Catalogue

**Improving Web Application Performance Using Redis Caching**

A full-stack product catalogue built with plain HTML/CSS/JavaScript, FastAPI, Supabase (PostgreSQL) and Redis. The app is designed to show what Redis caching actually does: every API response tells you whether it came from Redis (**CACHE HIT**) or from the database (**CACHE MISS**), and how long the server took.

---

## Objective

Every database query costs time: a network round trip to Supabase, query execution and serialisation. In a product catalogue, most requests read the same data again and again.

**Redis** is an in-memory key–value store. Reading from memory is much faster than querying a remote database, so this project keeps **temporary copies** of frequently read data in Redis:

- **Supabase is the source of truth.** All writes go there.
- **Redis is only a cache.** Every entry expires after `CACHE_TTL` seconds (default 300 = 5 minutes) and is deleted early whenever the underlying data changes.
- If Redis goes down, the app keeps working and reads directly from Supabase.

The project uses the **Cache-Aside (Lazy Loading)** pattern: the application checks the cache first and loads data into it only when it is missing.

---

## Architecture

```text
HTML / CSS / JavaScript   (frontend, fetch API)
          ↓
       FastAPI            (backend, Python)
          ↓
        Redis             (cache — temporary copies, TTL 5 min)
          ↓  on a MISS
 Supabase PostgreSQL      (database — source of truth)
```

### Cache-aside flow (`GET /api/products/1`)

```text
Request ──► Check Redis key "product:1"
               │
       ┌───────┴────────┐
      HIT              MISS
       │                │
 Return cached     Query Supabase
 data (Supabase         │
 NOT queried)      Store in Redis (TTL 300s)
                        │
                     Return data
```

---

## Features

- Product catalogue with cards, search (case-insensitive, no page reload) and category filters
- Product details page with a live **Redis cache status card** (HIT/MISS, response time, data source)
- Admin page: add, edit and delete products
- Redis caching for single products, the full list, categories and searches
- Cache invalidation on create/update/delete (with SCAN for search keys, never `KEYS *`)
- `X-Cache` and `X-Response-Time` headers on cached responses, measured from real requests
- **Cache Monitor**: hits, misses, hit rate, number of cached keys, each key's remaining TTL
- **Cache Performance**: real first-request (MISS) vs second-request (HIT) timings, plus a one-click live test
- System status (API / database / Redis) from `/api/health`
- If Redis is unavailable, the app reads straight from Supabase instead of failing
- Manual input validation (no Pydantic models) with clear `400` errors
- Loading, error, empty and image-fallback states
- Dark, responsive dashboard design in plain CSS

---

## Project structure

```text
project-catalogue/
├── .github/workflows/
│   └── ci.yml            GitHub Actions: lint, build images, smoke test
├── docker-compose.yml    Runs frontend + backend + Redis together
├── backend/
│   ├── Dockerfile        Backend image (python:3.11-slim + uvicorn)
│   ├── .dockerignore     Keeps .env and venv out of the image
│   ├── app.py            FastAPI app: routes, cache-aside logic, validation, invalidation, CORS, timing
│   ├── database.py       Supabase client + product queries (raises DatabaseError on failure)
│   ├── redis_cache.py    Redis client, JSON get/set with TTL, delete, SCAN, key listing, failure handling
│   ├── cache_stats.py    In-memory hit/miss counters and hit-rate calculation
│   ├── requirements.txt
│   ├── .env              Your secrets (git-ignored)
│   ├── .env.example      Template for .env
│   └── .gitignore
├── frontend/
│   ├── Dockerfile        Frontend image (nginx)
│   ├── index.html        Hero, product catalogue, search, filters, Cache Monitor
│   ├── product.html      Product details + Redis cache card
│   ├── admin.html        Add / edit / delete products
│   ├── css/style.css     Complete theme
│   └── js/
│       ├── config.js     API_BASE_URL (the only frontend setting)
│       ├── app.js        fetch() API helper, shared UI helpers, products page, Cache Monitor
│       ├── product.js    Product details page
│       └── admin.js      Admin CRUD
└── README.md
```

---

## API

| Method | Endpoint | Description | Cache key |
|---|---|---|---|
| GET | `/api/products` | All products | `products:all` |
| GET | `/api/products?category=Mobile` | Filter by category | `products:category:Mobile` |
| GET | `/api/products?search=iphone` | Search name/description | `products:search:iphone` |
| GET | `/api/products/{id}` | One product | `product:{id}` |
| POST | `/api/products` | Create (201) | invalidates caches |
| PUT | `/api/products/{id}` | Update (200) | invalidates caches |
| DELETE | `/api/products/{id}` | Delete (200) | invalidates caches |
| GET | `/api/cache/stats` | Hits, misses, hit rate, cached keys (with TTLs) | — |
| POST | `/api/cache/clear` | Delete all of this app's keys (for demos) | — |
| GET | `/api/health` | Backend / database / Redis status | — |

Search terms are normalised to lowercase, so `iPhone`, `IPHONE` and `iphone` all use `products:search:iphone`. If both `search` and `category` are given, the key is `products:search:{term}:category:{category}`.

### Response headers

```text
X-Cache: HIT | MISS
X-Response-Time: 3.41ms        measured by FastAPI for this request
X-Data-Source: redis | supabase | supabase-only
```

`supabase` means "read from Supabase and stored in Redis". `supabase-only` means Redis was unavailable, so the data came straight from the database.

### Status codes

`200` OK · `201` created · `400` invalid input / invalid ID · `404` not found · `500` database error (as a clean message like `{"error": "Unable to retrieve products"}`, with no raw exception).

### Cache invalidation

| Action | Keys deleted |
|---|---|
| Create | `products:all`, `products:category:{category}`, all `products:search:*` |
| Update | `product:{id}`, `products:all`, old and new `products:category:*`, all `products:search:*` |
| Delete | `product:{id}`, `products:all`, `products:category:{category}`, all `products:search:*` |

Search keys are found with **`SCAN`**, which walks the keyspace in small batches without blocking Redis (unlike `KEYS *`). The Admin page shows the keys each change deleted.

---

## Setup

### 1. Configure secrets

Copy the template and fill in your values:

```bash
cd backend
copy .env.example .env      # Windows   (macOS/Linux: cp .env.example .env)
```

`backend/.env`:

```env
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_KEY=<your-supabase-key>
REDIS_URL=redis://default:<password>@<host>:<port>
CACHE_TTL=300
```

- **SUPABASE_URL / SUPABASE_KEY**: Supabase dashboard → *Project Settings → API*.
  The backend creates, updates and deletes rows. If Row Level Security (RLS) is enabled on `products`, an `anon` key can only do what your policies allow. Either add insert/update/delete policies, or use the `service_role` key. The service-role key is safe here because it stays on the server and never reaches the browser.
- **REDIS_URL**: from your Redis provider. Use `redis://localhost:6379` for a local Redis, or `rediss://…` (with two s's, for TLS) for most cloud providers such as Upstash or Redis Cloud.
- **CACHE_TTL**: cache lifetime in seconds. It is read in one place only (`redis_cache.py`).

`.env` is listed in `backend/.gitignore` and must never be committed. The frontend never sees these values.

The `products` table and seed data already exist in Supabase. Nothing needs to be created.

### 2. Backend

```bash
cd backend
python -m venv venv
```

Windows:

```bash
venv\Scripts\activate
```

macOS/Linux:

```bash
source venv/bin/activate
```

Install and run:

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

The API runs at `http://localhost:8000`. To check it, open `http://localhost:8000/api/health`; it should return:

```json
{"backend": "ok", "database": "connected", "redis": "connected"}
```

Interactive API docs are available at `http://localhost:8000/docs`.

### 3. Frontend

Serve the `frontend` folder over HTTP. **Do not open the HTML files directly via `file://`**, because the browser's CORS rules will block the API calls.

Option A, using Python:

```bash
cd frontend
python -m http.server 5500
```

Then open **http://localhost:5500**.

When using `start_all.bat`, the launcher selects the next free frontend port if port 5500 is already occupied. If port 8000 is occupied, it stops with an error rather than connecting this UI to another project's backend.

Option B, using VS Code Live Server: right-click `frontend/index.html` → *Open with Live Server* (default port 5500).

CORS allows `http://localhost:5500` and `http://127.0.0.1:5500`. If you serve the frontend from another origin, add it to `backend/.env`:

```env
FRONTEND_ORIGINS=http://localhost:3000
```

### Changing the API URL (deployment)

The frontend has a single setting in `frontend/js/config.js`:

```javascript
const API_BASE_URL = "http://localhost:8000";
```

Change it to your deployed backend URL. This is the only value the frontend needs; Supabase and Redis credentials stay on the backend.

---

## Running with Docker

Docker Compose runs the whole app in three containers, so you don't need Python or Redis installed. Only [Docker Desktop](https://www.docker.com/products/docker-desktop/) is required.

| Container | Image | Port |
|---|---|---|
| `frontend` | nginx serving `frontend/` | http://localhost:5500 |
| `backend` | FastAPI + Uvicorn (`backend/Dockerfile`) | http://localhost:8000 |
| `redis` | `redis:7-alpine` | internal only |

1. Create `backend/.env` with your Supabase keys (see [Configure secrets](#1-configure-secrets)). `REDIS_URL` is ignored here: Compose points the backend at the Redis container instead.
2. Start everything:

   ```bash
   docker compose up --build
   ```

3. Open **http://localhost:5500**.

Stop with `Ctrl+C`, or `docker compose down` if it runs in the background (`-d`). `.env` is never copied into an image (see `backend/.dockerignore`); Compose passes it in when the container starts.

---

## CI (GitHub Actions)

`.github/workflows/ci.yml` runs on every push and pull request:

1. **Lint**: `ruff check backend`
2. **Build**: `docker compose build` builds the backend and frontend images
3. **Smoke test**: starts the stack and checks that `/api/health` reports the backend as `ok` and Redis as `connected`, and that the frontend is served

CI has no Supabase secrets, so the database shows as `disconnected` there; that's expected. The result appears as ✅ or ❌ next to each commit on GitHub.

---

## Redis demonstration

You can follow this in the UI (product page + Cache Monitor) or with `curl -i` to see the headers.

### Step 1: first request → CACHE MISS

Open **iPhone 16** (`product.html?id=1`), or:

```bash
curl -i http://localhost:8000/api/products/1
```

```text
X-Cache: MISS
X-Data-Source: supabase
X-Response-Time: 85.12ms
```

Redis didn't have the key yet, so Supabase was queried and Redis now stores `product:1` with a 300-second TTL. You can see the key in **Cache Monitor → Cached Keys**.

### Step 2: same request again → CACHE HIT

Refresh the page or click **Fetch again**:

```text
X-Cache: HIT
X-Data-Source: redis
X-Response-Time: 2.87ms
```

The data came from Redis; **Supabase was not queried**. The **Cache Performance** panel now compares the two real timings.

### Step 3: update the product → cache invalidated

In **Admin**, click **Edit** on iPhone 16, change the price from ₹79,999 to ₹74,999 and click **Update Product**.

Backend:

```text
Supabase → UPDATE products SET price = 74999 WHERE id = 1
Redis    → DEL product:1, products:all, products:category:Mobile, products:search:*
```

The Admin page lists the deleted keys.

### Step 4: open the product again → CACHE MISS

The old cached value is gone, so the backend reads the **new** price from Supabase and caches it again.

### Step 5: refresh again → CACHE HIT

The updated product is now served from Redis.

### Live test (one click)

In **Cache Monitor → Cache Performance**, pick a product and click **Run test**. With "Clear the Redis cache first" ticked, the app clears its keys, requests the product twice and shows the real MISS vs HIT timings.

### TTL

**Cached Keys** shows each key's remaining lifetime counting down from 300 s. When it reaches 0, Redis deletes the key automatically and the next request is a MISS again. To see this faster, set `CACHE_TTL=20` in `.env` and restart the backend.

### Verifying Redis directly (optional)

With `redis-cli` (or your provider's console):

```bash
redis-cli -u "$REDIS_URL" --scan --pattern "product*"
redis-cli -u "$REDIS_URL" TTL product:1
redis-cli -u "$REDIS_URL" GET product:1
```

### Redis failure fallback

Stop Redis (or set an invalid `REDIS_URL` and restart). The app keeps working: responses show `CACHE MISS` with data source *Supabase (Redis unavailable)*, the backend logs a warning, and the status indicators show Redis as disconnected. After a failure the backend skips Redis for 10 seconds, so each request doesn't wait for a connection timeout.

---

## Cache statistics

`GET /api/cache/stats`:

```json
{
  "hits": 20,
  "misses": 5,
  "total_requests": 25,
  "hit_rate": 80,
  "cached_keys": 7,
  "ttl": 300,
  "redis": "connected",
  "keys": [{"key": "product:1", "ttl": 241}]
}
```

- `hit_rate = hits / (hits + misses) × 100` (0 when there have been no requests)
- `hits` and `misses` are in-memory counters in `cache_stats.py`. They reset when the backend restarts and are never stored in Supabase.
- `cached_keys` is counted from Redis with SCAN.

---

## Testing checklist

- [ ] Get all products: product grid loads
- [ ] Get individual product: details page loads
- [ ] Product cache MISS: first open of a product shows amber **CACHE MISS**
- [ ] Product cache HIT: refresh shows green **CACHE HIT**, with a lower response time
- [ ] Search: type `iphone`; results update without a page reload
- [ ] Search cache: search `IPHONE` after `iphone` → HIT (same key `products:search:iphone`)
- [ ] Category filter: click *Mobile*
- [ ] Category cache: click *Mobile* again → HIT (`products:category:Mobile`)
- [ ] Add product: Admin form returns 201 and the product appears
- [ ] Update product: values change; Admin shows the invalidated keys
- [ ] Delete product: product disappears; its key is invalidated
- [ ] Cache invalidation: product HIT → edit → MISS (new data) → HIT
- [ ] TTL: Cached Keys countdown; key disappears after expiry
- [ ] Cache statistics: hits, misses, hit rate and keys update
- [ ] Health check: header pill and System Status show all green
- [ ] Redis failure fallback: stop Redis; products still load (data source "Supabase (Redis unavailable)")
- [ ] Invalid product ID: `product.html?id=abc` → "Product not found."; API returns 400
- [ ] Missing product ID: `product.html?id=99999` → "Product not found."; API returns 404
- [ ] Invalid price: `-5` or `abc` → 400 with a message
- [ ] Missing product name → 400 "Product name is required"
- [ ] Empty search: clearing the box shows all products (`products:all`)
- [ ] Broken image: the `example.com` image URLs show the ◈ IMAGE UNAVAILABLE placeholder
- [ ] Backend unavailable: stop uvicorn → "Unable to connect to the server…"

---

## Technology choices

| Layer | Technology | Why |
|---|---|---|
| Frontend | HTML, CSS, vanilla JS (`fetch`) | No build step; easy to read and explain |
| API | FastAPI + Uvicorn | Simple Python routing; request bodies handled as plain dictionaries |
| Cache | Redis (`redis` Python client) | In-memory, sub-millisecond reads, built-in key expiry (TTL) |
| Database | Supabase PostgreSQL (`supabase` client) | Hosted Postgres, source of truth |
| Config | python-dotenv | Keeps secrets out of the code |
