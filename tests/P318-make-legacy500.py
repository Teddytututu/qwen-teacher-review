#!/usr/bin/env python3
"""Build one exact-shape legacy migration input from all 500 real manifest rows.

Actions are synthetic. This is a storage/migration fixture, not review evidence.
The legacy sync state is explicitly is_test=true; there is no session token.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
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


def compact(value: object) -> str:
    # Matches modern JSON.stringify for these data fields: compact separators,
    # insertion order, unescaped Unicode, no trailing newline.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def fixed_uuid(value: str) -> str:
    # Deterministic v4-shaped fixture ID; no external identifier is fabricated.
    raw = hashlib.sha256(value.encode("utf-8")).digest()[:16]
    return str(uuid.UUID(bytes=raw, version=4))


def main() -> None:
    args = arguments()
    source_path = args.root / "data.json"
    data = json.loads(source_path.read_text(encoding="utf-8"))
    labels = {}
    pending = []
    seen = []
    start = datetime(2026, 11, 26, 4, 0, 0, tzinfo=timezone.utc)
    for index, item in enumerate(data["items"]):
        compared = [{"key": v["key"], "native_sha256": v["native_sha256"]} for v in item["versions"]]
        choice = "new" if any(v["key"] == "new" for v in item["versions"]) else "old"
        selected = next(v for v in item["versions"] if v["key"] == choice)
        timestamp = (start + timedelta(milliseconds=index)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        decision = {
            "source_uid": item["source_uid"],
            "source_sha256": item["source_sha256"],
            "versions": compared,
            "choice": choice,
            "updated_at": timestamp,
        }
        comparison_key = item["source_uid"] + "|" + "|".join(v["key"] + ":" + v["native_sha256"] for v in compared)
        labels[comparison_key] = decision
        pending.append({
            **decision,
            "source_id": item["source_id"],
            "split": item["split"],
            "license": item["license"],
            "attribution": item["attribution"],
            "selected_native_sha256": selected["native_sha256"],
            "selected_generation_version": selected["generation_version"],
            "event_id": fixed_uuid("P318-legacy500:" + item["source_uid"]),
        })
        seen.append("|".join([item["source_uid"], timestamp, choice] + [v["native_sha256"] for v in compared]))
    state = {
        "client_id": fixed_uuid("P318-legacy500:client"),
        "pending": pending,
        "seen": seen,
        "confirmed": 0,
        "receipts": [],
        "is_test": True,
    }
    storage = {
        "qwen-human-review:" + data["dataset_id"]: compact(labels),
        "qwen-github-sync:" + data["dataset_id"]: compact(state),
    }
    per_key = [{
        "key": key,
        "key_utf16_code_units": units(key),
        "value_utf16_code_units": units(value),
        "key_utf8_bytes": len(key.encode("utf-8")),
        "value_utf8_bytes": len(value.encode("utf-8")),
        "value_sha256_utf8": hashlib.sha256(value.encode("utf-8")).hexdigest(),
    } for key, value in storage.items()]
    size = {
        "measurement": "Exact serialized keys plus values before migration; this does not assume a browser quota.",
        "source_rows_used": len(data["items"]),
        "legacy_label_records": len(labels),
        "legacy_pending_events": len(pending),
        "legacy_seen_fingerprints": len(seen),
        "unique_pending_event_ids": len({x["event_id"] for x in pending}),
        "choice_counts": dict(Counter(x["choice"] for x in pending)),
        "per_key": per_key,
        "total_utf16_code_units": sum(units(k) + units(v) for k, v in storage.items()),
        "total_utf8_bytes": sum(len(k.encode("utf-8")) + len(v.encode("utf-8")) for k, v in storage.items()),
    }
    fixture = {
        "fixture_id": "P318-legacy500-unauthed",
        "is_test": True,
        "description": "500 synthetic decisions, one per actual manifest source; exact original draft/pending/seen shape; never a human-review completion claim.",
        "source_file": str(source_path),
        "source_file_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        "dataset_id": data["dataset_id"],
        "session_storage": {},
        "local_storage": storage,
        "expected": {
            "original_keys_unchanged": True,
            "current_comparisons_after_migration": len(labels),
            "distinct_synthetic_actions": len(labels),
            "pending_before_authorization": len(pending),
            "github_requests_before_authorization": 0,
            "legacy_evidence_records_if_both_snapshot_and_queue_are_retained": len(labels) + len(pending),
        },
        "initial_storage_size": size,
    }
    folder = args.output
    output = folder / "P318-legacy500-input.json"
    output.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (folder / "P318-legacy500-size.json").write_text(json.dumps(size, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "source_rows": len(data["items"]),
                      "total_utf16_code_units": size["total_utf16_code_units"],
                      "total_utf8_bytes": size["total_utf8_bytes"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
