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


def load_harness_contract() -> dict:
    """Read the language-neutral lockstep contract shared with the pyodide
    harness (tools/harness-contract.json), resolved relative to this file —
    not cwd — so the twin reads the same literal data from any working dir."""
    contract_path = Path(__file__).resolve().parent / "harness-contract.json"
    return json.loads(contract_path.read_text(encoding="utf-8"))


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

    contract = load_harness_contract()
    pc_window = contract["powerCurveDeltaWindowDaysAgo"]

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

    # Conditional curve / athlete kwargs — mirror the pyodide harness. Each
    # derived kwarg is computed ONLY when its source fixture key is present;
    # absent keys reproduce the prior stub so fixtures carrying none stay
    # byte-identical (including the absence of the upstream null-blocks' window
    # keys). `fixture` is already a plain dict here, so no tracker bypass needed.
    power_curves = fixture.get("power_curves")
    hr_curves = fixture.get("hr_curves")
    sus_curves = fixture.get("sustainability_curves")
    athlete = fixture.get("athlete")

    if power_curves:
        pc_end1 = today
        pc_start1 = (frozen_now - timedelta(days=pc_window["win1StartDaysAgo"])).strftime("%Y-%m-%d")
        pc_end2 = (frozen_now - timedelta(days=pc_window["win2EndDaysAgo"])).strftime("%Y-%m-%d")
        pc_start2 = (frozen_now - timedelta(days=pc_window["win2StartDaysAgo"])).strftime("%Y-%m-%d")
        pc_dates = (pc_start1, pc_end1, pc_start2, pc_end2)
    else:
        pc_dates = None

    if sus_curves:
        sus_end = today
        sus_start = (
            frozen_now - timedelta(days=sync.SUSTAINABILITY_WINDOW_DAYS - 1)
        ).strftime("%Y-%m-%d")
        sus_window = (sus_start, sus_end)
    else:
        sus_window = None

    if athlete:
        sport_settings = sync._build_sport_thresholds(athlete)
        power_model = sync._extract_power_model_from_wellness(latest)
        vo2max = latest.get("vo2max")
    else:
        sport_settings = {}
        power_model = {}
        vo2max = None

    # dfa_a1_profile assembly — mirror the pyodide harness. When the fixture
    # carries per-second streams, join them to the activities array (String(id)
    # both sides) and run each qualifying stream through _compute_dfa_block,
    # building the _intervals_data['activities'] entries the profile reads.
    # Absent streams leave _intervals_data empty so the profile stays null and
    # fixtures without streams keep byte-identical snapshots. `fixture` is a
    # plain dict here, so no tracker bypass is needed.
    streams = fixture.get("streams")
    if streams:
        dfa_activities = []
        for sact in fixture.get("activities", []):
            if not isinstance(sact, dict):
                continue
            srec = streams.get(str(sact.get("id")))
            if not srec or not srec.get("dfa_a1"):
                continue
            dfa_block = sync._compute_dfa_block(srec)
            if dfa_block is None:
                continue
            dfa_activities.append({
                "activity_id": sact.get("id"),
                "date": (sact.get("start_date_local") or "")[:10],
                "type": sact.get("type", "Unknown"),
                "name": sact.get("name", ""),
                "dfa": dfa_block,
            })
        if dfa_activities:
            sync._intervals_data = {"activities": dfa_activities}

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
            power_model=power_model,
            benchmark_indoor=bench_none,
            benchmark_outdoor=bench_none,
            vo2max=vo2max,
            formatted_planned_workouts=[],
            race_calendar=None,
            power_curve_data=power_curves,
            power_curve_dates=pc_dates,
            hr_curve_data=hr_curves,
            sustainability_curves=sus_curves or {},
            sustainability_window=sus_window,
            sport_settings=sport_settings,
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

    if "__error__" not in derived:
        # === has_intervals per-activity classifier (v3.106) ===
        # Hoisted from sync.py:7866-7873 inside _format_activities. The upstream
        # emits has_intervals per activity in the formatted activity dict; we
        # surface it as a top-level derived key so the parity gate can assert
        # it without ingesting the full per-activity display block.
        #
        # `fixture` here is already a plain dict (no contract-tracking wrapper
        # like the pyodide twin's _TrackedDict), so it plays the role of the
        # pyodide harness's reparsed _raw_fixture directly.
        intervals_raw = fixture.get("intervals") or {}
        has_intervals = {}
        for act in activities_all:
            if not isinstance(act, dict):
                continue
            act_id = str(act.get("id"))
            entry = intervals_raw.get(act_id)
            flag = False
            if entry:
                for seg in entry.get("intervals") or []:
                    if isinstance(seg, dict) and seg.get("type") == "WORK":
                        flag = True
                        break
            has_intervals[act_id] = flag
        derived["has_intervals"] = {
            k: has_intervals[k] for k in sorted(has_intervals.keys())
        }

        # === effort_response_signal per-activity classifier (v3.105 / v11.34) ===
        # Hoisted from sync.py:3493-3534 (_classify_effort_response) +
        # sync.py:7858-7860 per-activity emission inside _format_activities.
        effort_response = {}
        for act in fixture.get("activities", []):
            if not isinstance(act, dict):
                continue
            act_id = str(act.get("id"))
            effort_response[act_id] = sync._classify_effort_response(
                act.get("icu_intensity"), act.get("icu_rpe")
            )
        derived["effort_response_signal"] = {
            k: effort_response[k] for k in sorted(effort_response.keys())
        }

        # === weight_signal (v3.112) ===
        # Hoisted from sync.py:2746-2752 outside _calculate_derived_metrics.
        # The upstream assigns the result to data["current_status"]["weight"];
        # we surface it as a top-level derived key for the parity gate.
        #
        # _load_ftp_history is monkey-patched to read from the fixture's
        # ftp_history_indoor / ftp_history_outdoor records instead of disk —
        # the production helper reads ftp_history.json from cwd, which is
        # neither portable nor reproducible in the harness.
        raw_ftp_indoor = fixture.get("ftp_history_indoor") or {}
        raw_ftp_outdoor = fixture.get("ftp_history_outdoor") or {}
        sync._load_ftp_history = lambda: {
            "indoor": raw_ftp_indoor,
            "outdoor": raw_ftp_outdoor,
        }
        raw_current_ftp_outdoor = fixture.get("current_ftp_outdoor")
        raw_eftp = fixture.get("eftp")
        weight_sport_settings = (
            {"cycling": {"ftp": raw_current_ftp_outdoor}}
            if raw_current_ftp_outdoor
            else {}
        )
        weight_power_model = {"eftp": raw_eftp} if raw_eftp else {}
        raw_wellness = fixture.get("wellness") or []
        weight_signal_value = sync._build_weight_signal(
            raw_wellness,
            weight_sport_settings,
            weight_power_model,
            None,
        )
        # Display sub-dict is out of scope per Wave 6 deferral — strip before
        # snapshotting so the parity gate doesn't pin a contract we don't ship.
        if weight_signal_value and "display" in weight_signal_value:
            del weight_signal_value["display"]
        derived["weight_signal"] = weight_signal_value

    # Explode the capability dict into capability.<sub> sibling keys, in
    # lockstep with the pyodide harness's per-sub-key emission so
    # diff-pyodide-vs-cpython compares the same key set.
    if isinstance(derived.get("capability"), dict):
        for _sub, _val in list(derived["capability"].items()):
            derived[f"capability.{_sub}"] = _val

    payload = json.dumps(derived, default=str, sort_keys=True, indent=2) + "\n"
    if args.out is None:
        sys.stdout.write(payload)
    else:
        args.out.write_text(payload, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
