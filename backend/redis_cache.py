"""
Redis caching layer.

Redis is only an optimisation: every function here catches Redis errors,
logs them and returns a safe value, so the API keeps working (straight from
Supabase) even when Redis is down.
"""

import json
import logging
import os
import time
from pathlib import Path

import redis
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

logger = logging.getLogger("redis_cache")

REDIS_URL = os.getenv("REDIS_URL", "").strip()

try:
    CACHE_TTL = int(os.getenv("CACHE_TTL", "300"))
except ValueError:
    logger.warning("CACHE_TTL is not a valid integer, falling back to 300 seconds")
    CACHE_TTL = 300

# Every key this app creates starts with one of these prefixes.
APP_KEY_PATTERNS = ("product:*", "products:*")

# After a connection failure, skip Redis for a few seconds so every request
# doesn't wait for the connection timeout while Redis is down.
RETRY_AFTER_SECONDS = 10
_down_until = 0.0

_client = None


class RedisUnavailable(Exception):
    """Raised while Redis is in its back-off window after a failure."""


def _mark_down(exc):
    global _down_until
    if isinstance(exc, (redis.ConnectionError, redis.TimeoutError, ValueError)):
        _down_until = time.monotonic() + RETRY_AFTER_SECONDS


def get_client():
    """Create the Redis client once and reuse its connection pool."""
    global _client
    if time.monotonic() < _down_until:
        raise RedisUnavailable("skipping Redis, retrying shortly")
    if _client is None:
        _client = redis.Redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
            health_check_interval=30,
        )
    return _client


def get_json(key):
    """
    Read a cached JSON value.

    Returns (value, redis_ok):
      - (data, True)  -> cache HIT
      - (None, True)  -> cache MISS
      - (None, False) -> Redis unavailable, caller should fall back to Supabase
    """
    try:
        raw = get_client().get(key)
    except Exception as exc:
        _mark_down(exc)
        logger.warning("Redis GET %s failed: %s", key, exc)
        return None, False

    if raw is None:
        return None, True

    try:
        return json.loads(raw), True
    except json.JSONDecodeError:
        logger.warning("Corrupted cache entry %s, ignoring it", key)
        return None, True


def set_json(key, value, ttl=CACHE_TTL):
    """Store a value as JSON with an expiry time. Returns True on success."""
    try:
        get_client().set(key, json.dumps(value, default=str), ex=ttl)
        return True
    except Exception as exc:
        _mark_down(exc)
        logger.warning("Redis SET %s failed: %s", key, exc)
        return False


def delete_keys(keys):
    """Delete specific keys. Returns the keys that actually existed."""
    keys = list(dict.fromkeys(k for k in keys if k))  # unique, keep order
    if not keys:
        return []
    try:
        pipe = get_client().pipeline()
        for key in keys:
            pipe.delete(key)
        results = pipe.execute()
        return [key for key, deleted in zip(keys, results) if deleted]
    except Exception as exc:
        _mark_down(exc)
        logger.warning("Redis DELETE failed: %s", exc)
        return []


def scan_keys(pattern):
    """Find keys matching a pattern using SCAN (non-blocking, unlike KEYS *)."""
    return list(get_client().scan_iter(match=pattern, count=100))


def delete_pattern(pattern):
    """Delete every key matching a pattern. Returns the deleted keys."""
    try:
        keys = scan_keys(pattern)
    except Exception as exc:
        _mark_down(exc)
        logger.warning("Redis SCAN %s failed: %s", pattern, exc)
        return []
    return delete_keys(keys)


def list_app_keys():
    """
    List this app's cached keys with their remaining TTL (seconds).

    Returns (keys, redis_ok) where keys is [{"key": ..., "ttl": ...}, ...].
    """
    try:
        names = []
        for pattern in APP_KEY_PATTERNS:
            names.extend(scan_keys(pattern))
        names = sorted(set(names))

        pipe = get_client().pipeline()
        for name in names:
            pipe.ttl(name)
        ttls = pipe.execute()
    except Exception as exc:
        _mark_down(exc)
        logger.warning("Redis key listing failed: %s", exc)
        return [], False

    # TTL of -2 means the key expired between SCAN and TTL.
    return [{"key": n, "ttl": t} for n, t in zip(names, ttls) if t != -2], True


def clear_app_keys():
    """Delete every key created by this app. Returns the deleted keys."""
    deleted = []
    for pattern in APP_KEY_PATTERNS:
        deleted.extend(delete_pattern(pattern))
    return deleted


def ping():
    try:
        return bool(get_client().ping())
    except Exception as exc:
        _mark_down(exc)
        logger.warning("Redis PING failed: %s", exc)
        return False
