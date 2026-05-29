#!/usr/bin/env python3
"""Branch-coverage probe for the Reference layer's derived-metrics oracle.

Runs the upstream `_calculate_derived_metrics` (the function the parity
gate snapshots) against every committed golden fixture under host
CPython 3.12 + coverage.py (branch=True), then reports the branches the
current fixture set leaves UNEXERCISED.

Why host CPython, not the pyodide harness: coverage.py needs a real
process + filesystem for its trace hook and data file, which pyodide's
WASM sandbox doesn't provide. Host CPython 3.12 matches pyodide 0.29.4's
interpreter and is already the proven twin path
(`tools/snapshot-section-11-native.py` + `tools/diff-pyodide-vs-cpython.ts`).
This is a dev-time spot-check tool — not part of `pnpm test` (needs uv +
Python 3.12 + coverage).

Scope: coverage is attributed to the upstream sync.py file; the report is
filtered to functions ACTUALLY ENTERED during metric computation
(`_calculate_derived_metrics` + its executed callees). Functions never
entered are the API/sync machinery the oracle path never touches — noise,
filtered out.

Usage (via the TS wrapper, which builds the manifest):

  uv run --python 3.12 --with coverage \\
      tools/measure-reference-coverage-native.py \\
      --manifest /tmp/coverage-manifest.json \\
      --section-11-repo ../section-11 \\
      --out /tmp/coverage-report.json

The manifest is a JSON list of {"path": "<fixture.json>", "frozen_now": "<iso>"}.
"""

from __future__ import annotations

import argparse
import ast
import datetime as _dt_module
import json
import os
import sys
import tempfile
import traceback
import types
from datetime import datetime, timedelta
from pathlib import Path

import coverage

# Mutable frozen-now cell: _FrozenDateTime reads it so the same exec'd
# sync.py can be driven with a different anchor per fixture without
# re-exec'ing (the `from datetime import datetime` binding inside sync.py
# is fixed at exec time, so the patch must be installed once, up front).
_FROZEN: dict = {"now": datetime(2026, 5, 10, 12, 0, 0)}


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--section-11-repo", type=Path, default=repo_root.parent / "section-11")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    return parser.parse_args()


def stub_requests() -> None:
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


def install_frozen_datetime() -> None:
    class _FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            fn = _FROZEN["now"]
            return fn if tz is None else fn.replace(tzinfo=tz)

        @classmethod
        def utcnow(cls):
            return _FROZEN["now"]

        @classmethod
        def today(cls):
            return _FROZEN["now"]

    _dt_module.datetime = _FrozenDateTime  # type: ignore[assignment]


def slice_window(items, key, oldest, newest):
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        d = it.get(key, "")
        if not isinstance(d, str):
            continue
        if oldest <= d[:10] <= newest:
            out.append(it)
    return out


def latest_wellness(rows):
    if not rows:
        return {}
    return sorted(rows, key=lambda r: r.get("id", ""), reverse=True)[0]


def run_one_fixture(IntervalsSync, fixture: dict, frozen_now: datetime) -> None:
    """Drive _calculate_derived_metrics for a single fixture. Mirrors the
    arg-marshalling of tools/snapshot-section-11-native.py exactly so the
    code paths under coverage match the oracle the parity gate snapshots."""
    _FROZEN["now"] = frozen_now
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
    current_tsb = (current_ctl - current_atl) if current_ctl is not None and current_atl is not None else 0.0

    sync = IntervalsSync(
        athlete_id="stub-athlete",
        intervals_api_key="stub-key",
        github_token=None,
        debug=False,
    )
    sync._intervals_data = {}
    bench_none = (None, None, None)
    sync._calculate_derived_metrics(
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


def _first_body_line(node) -> int:
    """First executable body line, skipping a leading docstring. A function's
    `def` line executes at module-load (to create the function object), so it
    is NOT evidence the function was called — only a body line is."""
    body = node.body
    idx = 0
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(getattr(body[0], "value", None), ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        idx = 1  # skip docstring
    return body[idx].lineno if idx < len(body) else node.lineno


def function_ranges(source: str) -> list[dict]:
    """Every def/async-def in sync.py with its [start, end] span + first body
    line, via AST. body_start is what distinguishes 'defined' from 'called'."""
    tree = ast.parse(source)
    fns: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = node.lineno
            end = max(
                [start]
                + [getattr(n, "end_lineno", start) or start for n in ast.walk(node)]
            )
            fns.append({
                "name": node.name,
                "start": start,
                "end": end,
                "body_start": _first_body_line(node),
            })
    fns.sort(key=lambda f: f["start"])
    return fns


def main() -> int:
    args = parse_args()
    sync_py_path = (args.section_11_repo / "examples/sync.py").resolve()
    if not sync_py_path.exists():
        print(f"upstream sync.py not found at {sync_py_path}", file=sys.stderr)
        return 2
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))

    stub_requests()
    install_frozen_datetime()

    source = sync_py_path.read_text(encoding="utf-8")
    fns = function_ranges(source)

    # Keep coverage's binary data file out of the repo: write it to a temp
    # path rather than the default `.coverage` in the cwd.
    data_file = os.path.join(tempfile.gettempdir(), f"ref-coverage-{os.getpid()}.dat")
    cov = coverage.Coverage(branch=True, include=[str(sync_py_path)], data_file=data_file)
    cov.start()
    sync_ns: dict = {"__name__": "ref_oracle_under_coverage", "__file__": str(sync_py_path)}
    exec(compile(source, str(sync_py_path), "exec"), sync_ns)
    IntervalsSync = sync_ns["IntervalsSync"]

    ran: list[str] = []
    errors: list[dict] = []
    for entry in manifest:
        fx_path = Path(entry["path"])
        frozen = datetime.fromisoformat(entry["frozen_now"])
        try:
            fixture = json.loads(fx_path.read_text(encoding="utf-8"))
            run_one_fixture(IntervalsSync, fixture, frozen)
            ran.append(fx_path.name)
        except Exception as e:  # noqa: BLE001 — record, keep measuring the rest
            errors.append({"fixture": fx_path.name, "type": type(e).__name__, "message": str(e),
                           "traceback": traceback.format_exc()})
    cov.stop()

    data = cov.get_data()
    executed_lines = set(data.lines(str(sync_py_path)) or [])

    # Missing lines + branch arcs via coverage's analysis. analysis2 is the
    # public surface for missing lines; _analyze exposes branch arcs (kept
    # in a try/except so a coverage-API shift degrades to line-only).
    _f, statements, _excl, missing, _fmt = cov.analysis2(str(sync_py_path))
    missing_set = set(missing)
    missing_branch_arcs: dict[int, list[int]] = {}
    try:
        analysis = cov._analyze(str(sync_py_path))  # noqa: SLF001
        for src, dsts in analysis.missing_branch_arcs().items():
            missing_branch_arcs[int(src)] = sorted(int(d) for d in dsts)
    except Exception:  # noqa: BLE001
        missing_branch_arcs = {}

    def entered(fn: dict) -> bool:
        # A function ran iff a BODY line executed — the def line alone executes
        # at module-load for every function and is not evidence of a call.
        return any(ln in executed_lines for ln in range(fn["body_start"], fn["end"] + 1))

    report_fns = []
    for fn in fns:
        if not entered(fn):
            continue  # function never ran on the metrics path — not a callee
        rng = range(fn["start"], fn["end"] + 1)
        fn_missing_lines = sorted(ln for ln in missing_set if ln in rng)
        fn_missing_branches = {
            src: dsts for src, dsts in missing_branch_arcs.items() if src in rng
        }
        if not fn_missing_lines and not fn_missing_branches:
            continue  # fully covered — nothing to report
        report_fns.append({
            "function": fn["name"],
            "start_line": fn["start"],
            "end_line": fn["end"],
            "missing_lines": fn_missing_lines,
            # arc src->dst pairs the fixtures never took (e.g. an else never entered)
            "missing_branch_arcs": [{"from": s, "to": d} for s, dsts in fn_missing_branches.items() for d in dsts],
        })

    total_branches = 0
    covered_branches = 0
    try:
        analysis = cov._analyze(str(sync_py_path))  # noqa: SLF001
        n_branches, n_partial = analysis.numbers.n_branches, analysis.numbers.n_missing_branches
        total_branches = n_branches
        covered_branches = n_branches - n_partial
    except Exception:  # noqa: BLE001
        pass

    report = {
        "upstream_sync_py": str(sync_py_path),
        "fixtures_run": ran,
        "fixture_errors": errors,
        "summary": {
            "total_statements": len(statements),
            "executed_statements": len(statements) - len(missing_set),
            "total_branches": total_branches,
            "covered_branches": covered_branches,
            "functions_entered": sum(1 for fn in fns if entered(fn)),
            "functions_with_gaps": len(report_fns),
        },
        # Only functions the metrics path actually entered, that still have gaps.
        "uncovered_in_entered_functions": report_fns,
    }
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out is None:
        sys.stdout.write(payload)
    else:
        args.out.write_text(payload, encoding="utf-8")

    try:
        if os.path.exists(data_file):
            os.remove(data_file)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
