#!/usr/bin/env python3
"""Inspect actual P318 snapshot rows without inferring human-review completion."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="repository root (default: parent of tests/)")
    parser.add_argument("--output", type=Path, required=True,
                        help="result directory outside the repository; inputs remain read-only")
    args = parser.parse_args()
    args.root = args.root.resolve()
    args.output = args.output.resolve()
    if args.output == args.root or args.root in args.output.parents:
        parser.error("--output must be outside --root so the test source tree remains unchanged")
    args.output.mkdir(parents=True, exist_ok=True)
    return args


def main() -> None:
    args = arguments()
    data_path = args.root / "data.json"
    batch_path = args.root / "tests" / "fixtures" / "P318-qwen-annotation-batches.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    batches = json.loads(batch_path.read_text(encoding="utf-8"))
    rows = data["items"]
    by_uid = {x["source_uid"]: x for x in rows}
    manifest_issues = []
    key_owners = {}
    for index, row in enumerate(rows):
        key = row["source_uid"] + "|" + "|".join(
            v["key"] + ":" + v["native_sha256"] for v in row["versions"]
        )
        if key in key_owners:
            manifest_issues.append({"pointer": f"/items/{index}", "kind": "duplicate_comparison_key", "first_index": key_owners[key]})
        key_owners[key] = index
        for version in row["versions"]:
            for field in ("native_sha256", "config_sha256", "generation_version"):
                if not isinstance(version.get(field), str) or not version[field]:
                    manifest_issues.append({"pointer": f"/items/{index}", "version": version.get("key"), "missing_field": field})
    inspected_batches = []
    for batch_index, saved in enumerate(batches):
        batch = saved["data"]
        inspected_entries = []
        for event_index, event in enumerate(batch["entries"]):
            row = by_uid.get(event["source_uid"])
            matches = bool(row) and event["source_sha256"] == row["source_sha256"]
            current_versions = {(v["key"], v["native_sha256"]) for v in row["versions"]} if row else set()
            saved_versions = {(v["key"], v["native_sha256"]) for v in event["versions"]}
            inspected_entries.append({
                "pointer": f"/{batch_index}/data/entries/{event_index}",
                "source_uid": event["source_uid"],
                "event_id": event["event_id"],
                "updated_at": event["updated_at"],
                "choice": event["choice"],
                "source_sha_matches_current": matches,
                "compared_native_versions_match_current": saved_versions == current_versions,
                "selected_generation_version": event.get("selected_generation_version"),
                "all_compared_generation_versions_present": all("generation_version" in v for v in event["versions"]),
            })
        inspected_batches.append({
            "pointer": f"/{batch_index}",
            "path": saved["path"],
            "is_test": batch.get("is_test"),
            "dataset_id": batch.get("dataset_id"),
            "source_manifest_sha256": batch.get("source_manifest_sha256"),
            "entries": inspected_entries,
        })
    result = {
        "source_files": [
            {"filename": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in (data_path, batch_path)
        ],
        "manifest_reported_counts": data["counts"],
        "inspected_rows": len(rows),
        "unique_source_uids": len(by_uid),
        "unique_comparison_keys": len(key_owners),
        "rows_with_old_and_new": sum({"old", "new"} <= {v["key"] for v in x["versions"]} for x in rows),
        "rows_with_old_only": sum({v["key"] for v in x["versions"]} == {"old"} for x in rows),
        "manifest_issues": manifest_issues,
        "batches": inspected_batches,
        "interpretation": "Attached annotation batches are verification records; no human-review completion count is inferred.",
    }
    output = args.output / "P318-snapshot-inspection.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "rows": len(rows), "batches": len(batches), "manifest_issues": len(manifest_issues)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
