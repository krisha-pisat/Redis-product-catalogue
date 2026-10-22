"""
Supabase (PostgreSQL) access.

Supabase is the source of truth. Every function raises DatabaseError on
failure so the API can return a clean error without leaking raw exceptions.
"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent / ".env")

logger = logging.getLogger("database")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "").strip()

TABLE = "products"
COLUMNS = "id, name, description, price, category, image_url, created_at"

_client = None


class DatabaseError(Exception):
    """Raised when Supabase cannot complete a request."""


def get_client():
    """Create the Supabase client once and reuse it."""
    global _client
    if _client is None:
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _client


def _run(action, query_fn):
    """Run a query and convert any failure into DatabaseError."""
    try:
        return query_fn(get_client())
    except Exception as exc:
        logger.error("Supabase %s failed: %s", action, exc)
        raise DatabaseError(action) from exc


def fetch_products(category=None, search=None):
    """All products, optionally filtered by exact category and/or a search term."""

    def query(client):
        q = client.table(TABLE).select(COLUMNS)
        if category:
            q = q.eq("category", category)
        if search:
            # Case-insensitive match on name OR description.
            q = q.or_(f"name.ilike.%{search}%,description.ilike.%{search}%")
        return q.order("id").execute().data

    return _run("fetch products", query)


def fetch_product(product_id):
    """A single product, or None if it does not exist."""

    def query(client):
        rows = client.table(TABLE).select(COLUMNS).eq("id", product_id).limit(1).execute().data
        return rows[0] if rows else None

    return _run("fetch product", query)


def insert_product(data):
    def query(client):
        rows = client.table(TABLE).insert(data).execute().data
        return rows[0] if rows else None

    return _run("insert product", query)


def update_product(product_id, data):
    def query(client):
        rows = client.table(TABLE).update(data).eq("id", product_id).execute().data
        return rows[0] if rows else None

    return _run("update product", query)


def delete_product(product_id):
    def query(client):
        rows = client.table(TABLE).delete().eq("id", product_id).execute().data
        return rows[0] if rows else None

    return _run("delete product", query)


def ping():
    """True if a trivial query succeeds."""
    try:
        get_client().table(TABLE).select("id").limit(1).execute()
        return True
    except Exception as exc:
        logger.warning("Supabase health check failed: %s", exc)
        return False
