#!/usr/bin/env python3
"""Read the current public Qwen branch and check this patch's source baseline.

Python 3.10+, standard library. Performs anonymous GET requests only. Exit 0:
the five patch-baseline files match; 2: a read failed; 3: baseline changed.
No repository, branch, annotation batch, credential, or production file is written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


REPOSITORY = "Teddytututu/qwen-teacher-review"
BASE_COMMIT = "274acca49b1d1e23f78bf587db8f36fd759212cf"
BASELINES = {
    "app.js": "ad8eef8b5a04cdfbed1b75ca13a36ca04230220fe3304064adce13acdb6fac20",
    "sync.js": "644b0e5032b6d587fead8a819c0b04a9d46105265518b32a424c314bc9655d92",
    "index.html": "bfb0e15678e7e480759064c1212b2903a53e0b8067a82a44ab6cecc4ca5339dc",
    "style.css": "cc818b68689d9284d29adcccec1fdba67597849732fed4f99d1b02e798730ffc",
    "README.md": "aa785d6417cb002099222755a45813e490b092ea82d1f0142032cfe3bb3b1884",
}


def get(url: str, output: Path) -> tuple[bytes | None, dict[str, Any]]:
    record: dict[str, Any] = {
        "url": url,
        "requested_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "method": "GET",
    }
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "P318-public-baseline-check"})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read()
            record.update(status=response.status, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
        return data, record
    except (OSError, urllib.error.URLError) as error:
        record["error"] = str(error)
        return None, record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("P318-public-check"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    body, repo_record = get("https://github.com/" + REPOSITORY, args.output / "P318-current-repository.html")
    report: dict[str, Any] = {"repository": REPOSITORY, "baseline_commit": BASE_COMMIT, "reads": [repo_record]}
    commit = None
    if body is not None:
        # GitHub's public code view records the resolved branch commit.
        match = re.search(r'"refInfo":\{"name":"main"[^}]*"currentOid":"([0-9a-f]{40})"', body.decode("utf-8"))
        if match:
            commit = match.group(1)
    if commit is None:
        report.update(outcome="current_commit_unavailable", patch_baseline_matches=False)
        code = 2
    else:
        report["current_commit"] = commit
        outcomes = []
        for filename, expected in BASELINES.items():
            url = "https://raw.githubusercontent.com/" + REPOSITORY + "/" + commit + "/" + filename
            _, record = get(url, args.output / "current" / filename)
            record.update(filename=filename, expected_sha256=expected, matches_baseline=record.get("sha256") == expected)
            report["reads"].append(record)
            outcomes.append(record)
        unreadable = any("error" in row for row in outcomes)
        unchanged = all(row["matches_baseline"] for row in outcomes)
        report.update(outcome="read_failed" if unreadable else "baseline_matches" if unchanged else "baseline_changed", patch_baseline_matches=unchanged)
        code = 2 if unreadable else 0 if unchanged else 3
    report["exit_code"] = code
    target = args.output / "P318-public-check.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "reads"}, ensure_ascii=False, indent=2))
    print(str(target.resolve()))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
