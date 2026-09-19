"""Exponential-backoff retry for flaky calls (network timeouts, rate limits).

Usage:

from backend.retry import retry

@retry(on=requests.Timeout, attempts=5)
def fetch(url: str) -> bytes: ...

# Or for a one-off call:
data = retry(on=OSError)(read_remote)(path)
"""

import functools
import logging
import random
import time
from collections.abc import Callable
from typing import ParamSpec, TypeVar

logger = logging.getLogger(__name__)

P = ParamSpec("P")
R = TypeVar("R")


def retry(
    *,
    on: type[BaseException] | tuple[type[BaseException], ...] = Exception,
    attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    jitter: bool = True,
) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Call the decorated function up to `attempts` times while it raises `on`.

    Waits `base_delay` seconds after the first failure, then doubles the wait
    each time, capped at `max_delay`. With `jitter`, each wait is randomized
    between half and all of it so parallel callers don't retry in lockstep.
    Exceptions not in `on` propagate immediately; after the last attempt the
    original exception is re-raised unchanged.
    """
    if attempts < 1:
        raise ValueError("attempts must be at least 1")

    def decorator(fn: Callable[P, R]) -> Callable[P, R]:
        name = getattr(fn, "__qualname__", repr(fn))

        @functools.wraps(fn)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            attempt = 1
            while True:
                try:
                    return fn(*args, **kwargs)
                except on as error:
                    if attempt >= attempts:
                        raise
                    delay = min(max_delay, base_delay * 2 ** (attempt - 1))
                    if jitter:
                        delay *= random.uniform(0.5, 1.0)
                    logger.warning(
                        "%s failed (%s); retrying in %.1fs (attempt %d of %d)",
                        name,
                        error,
                        delay,
                        attempt + 1,
                        attempts,
                    )
                    time.sleep(delay)
                    attempt += 1

        return wrapper

    return decorator
