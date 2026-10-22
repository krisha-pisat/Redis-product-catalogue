"""
Application-level cache statistics.

Counters live in memory, so they reset whenever the backend restarts.
They are NOT stored in Supabase or Redis.
"""

import threading

_lock = threading.Lock()
_hits = 0
_misses = 0


def record_hit():
    global _hits
    with _lock:
        _hits += 1


def record_miss():
    global _misses
    with _lock:
        _misses += 1


def snapshot():
    """Return the current counters and the hit rate as a percentage."""
    with _lock:
        hits, misses = _hits, _misses

    total = hits + misses
    hit_rate = round(hits / total * 100, 2) if total > 0 else 0

    return {
        "hits": hits,
        "misses": misses,
        "total_requests": total,
        "hit_rate": hit_rate,
    }
