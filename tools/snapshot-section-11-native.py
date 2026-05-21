#!/usr/bin/env python3
"""Native-CPython twin of tools/snapshot-section-11.ts.

The pyodide harness in `tools/snapshot-section-11.ts` produces the
oracle JSON snapshots used as the Reference layer's ground truth.
Pyodide ships CPython compiled to WebAssembly; ~99% of stdlib
behavior is identical, but `math.fsum`, `statistics` edge cases,
and float-repr have historically diverged in narrow cases. This
script spot-checks parity by running the SAME logic against host
CPython 3.12 (matching pyodide 0.29.4's interpreter version) and
diffing the per-metric outputs via `tools/diff-pyodide-vs-cpython.ts`.

This script is intentionally a duplication of the harness prologue
in TS, not a shared module — the pyodide path lives inside a
heredoc literal in `tools/snapshot-section-11.ts` and can't be
import-shared without packaging gymnastics. The two paths must
stay in lock-step; the diff IS the lock-step check.

Usage (recommended, via uv):

  uv run --python 3.12 tools/snapshot-section-11-native.py \\
      > /tmp/native-snapshots.json

  # Or with arguments:
  uv run --python 3.12 tools/snapshot-section-11-native.py \\
      --section-11-repo /path/to/section-11 \\
      --fixture packages/core/tests/fixtures/golden/realistic-athlete.json \\
      --frozen-now 2026-05-10T12:00:00 \\
      --out /tmp/native-snapshots.json

The output JSON is a flat map of metric name → value, the same
shape `_calculate_derived_metrics` returns. `tools/diff-pyodide-vs-cpython.ts`
compares this against the committed pyodide snapshots.
"""

from __future__ import annotations

import argparse
import datetime as _dt_module
import json
import sys
import traceback
import types
from datetime import datetime, timedelta
from pathlib import Path


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--section-11-repo",
        type=Path,
        default=repo_root.parent / "section-11",
        help="Path to the section-11 checkout (defaults to ../section-11).",
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=repo_root / "packages/core/tests/fixtures/golden/realistic-athlete.json",
        help="Path to the golden fixture JSON.",
    )
    parser.add_argument(
        "--frozen-now",
        type=str,
        default="2026-05-10T12:00:00",
        help="ISO-8601 datetime to freeze datetime.now() to (matches the pyodide harness default).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output JSON path (defaults to stdout).",
    )
    return parser.parse_args()


def stub_requests() -> None:
    """Replace the `requests` module before sync.py imports it.

    Mirrors the pyodide harness's stub: returns inert _StubResponse
    objects from any get/post/put/delete/head. The direct-call path
    used here never actually fires them; the stub exists to satisfy
    `import requests` at sync.py module load.
    """

    class _StubResponse:
        def __init__(self, payload=None, status: int = 200) -> None:
            self._payload = payload if payload is not None else {}
            self.status_code = status

        def json(self):
            return self._payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise Exception(f"HTTP {self.status_code} (stub)")

    class _StubExceptions:
        Timeout = Exception
        RequestException = Exception
        ConnectionError = Exception
        HTTPError = Exception

    def _stub_call(*_a, **_k):
        return _StubResponse({})

    requests_stub = types.ModuleType("requests")
    requests_stub.get = _stub_call
    requests_stub.post = _stub_call
    requests_stub.put = _stub_call
    requests_stub.delete = _stub_call
    requests_stub.head = _stub_call
    requests_stub.exceptions = _StubExceptions
    sys.modules["requests"] = requests_stub


def install_frozen_datetime(frozen_now: datetime) -> None:
    """Monkey-patch datetime so .now()/.utcnow()/.today() are deterministic.

    Mirrors the pyodide harness's _FrozenDateTime class. Section-11's
    sync.py calls datetime.now() in ~48 sites for rolling-window math
    — without this, every snapshot drifts with wall clock.
    """

    class _FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return frozen_now
            return frozen_now.replace(tzinfo=tz)

        @classmethod
        def utcnow(cls):
            return frozen_now

        @classmethod
        def today(cls):
            return frozen_now

    _dt_module.datetime = _FrozenDateTime  # type: ignore[assignment]


def slice_window(items, key, oldest, newest):
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        d = it.get(key, "")
        if not isinstance(d, str):
            continue
        d10 = d[:10]
        if oldest <= d10 <= newest:
            out.append(it)
    return out


def latest_wellness(rows):
    if not rows:
        return {}
    return sorted(rows, key=lambda r: r.get("id", ""), reverse=True)[0]


def main() -> int:
    args = parse_args()
    sync_py_path = args.section_11_repo / "examples/sync.py"
    if not sync_py_path.exists():
        print(f"section-11 sync.py not found at {sync_py_path}", file=sys.stderr)
        return 2
    if not args.fixture.exists():
        print(f"Fixture not found: {args.fixture}", file=sys.stderr)
        return 2

    stub_requests()

    frozen_now = datetime.fromisoformat(args.frozen_now)
    install_frozen_datetime(frozen_now)

    sync_py_source = sync_py_path.read_text(encoding="utf-8")
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))

    sync_ns: dict = {"__name__": "section_11_sync_under_test", "__file__": str(sync_py_path)}
    exec(compile(sync_py_source, str(sync_py_path), "exec"), sync_ns)
    IntervalsSync = sync_ns["IntervalsSync"]

    activities_all = fixture.get("activities", [])
    wellness_all = fixture.get("wellness", [])
    today = frozen_now.strftime("%Y-%m-%d")
    oldest_7 = (frozen_now - timedelta(days=6)).strftime("%Y-%m-%d")
    oldest_28 = (frozen_now - timedelta(days=27)).strftime("%Y-%m-%d")

    activities_7d = slice_window(activities_all, "start_date_local", oldest_7, today)
    activities_28d = slice_window(activities_all, "start_date_local", oldest_28, today)
    wellness_7d = slice_window(wellness_all, "id", oldest_7, today)
    wellness_28d = slice_window(wellness_all, "id", oldest_28, today)
    latest = latest_wellness(wellness_28d) or {}
    current_ctl = latest.get("ctl") or 0.0
    current_atl = latest.get("atl") or 0.0
    current_tsb = (
        (current_ctl - current_atl)
        if current_ctl is not None and current_atl is not None
        else 0.0
    )

    sync = IntervalsSync(
        athlete_id="stub-athlete",
        intervals_api_key="stub-key",
        github_token=None,
        debug=False,
    )
    sync._intervals_data = {}

    bench_none = (None, None, None)
    try:
        derived = sync._calculate_derived_metrics(
            activities_7d=activities_7d,
            activities_28d=activities_28d,
            wellness_7d=wellness_7d,
            wellness_extended=wellness_28d,
            current_ctl=current_ctl,
            current_atl=current_atl,
            current_tsb=current_tsb,
            past_events=[],
            activities_for_consistency=activities_7d,
            power_model={},
            benchmark_indoor=bench_none,
            benchmark_outdoor=bench_none,
            vo2max=None,
            formatted_planned_workouts=[],
            race_calendar=None,
            power_curve_data=None,
            power_curve_dates=None,
            hr_curve_data=None,
            sustainability_curves={},
            sustainability_window=None,
            sport_settings={},
            icu_weight=latest.get("weight"),
        )
    except Exception as e:
        derived = {
            "__error__": {
                "type": type(e).__name__,
                "message": str(e),
                "traceback": traceback.format_exc(),
            }
        }

    payload = json.dumps(derived, default=str, sort_keys=True, indent=2) + "\n"
    if args.out is None:
        sys.stdout.write(payload)
    else:
        args.out.write_text(payload, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
