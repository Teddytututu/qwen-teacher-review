#!/usr/bin/env python3
"""Audit the two public Qwen review datasets without a model or network call.

Python 3.10+, standard library. This script reads original records and retains
their row indices in every output. It reports reviewer identity as recorded,
not as inferred from the phrase "human review" in a document or UI.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any


def read_json(path: Path) -> tuple[Any, str]:
    blob = path.read_bytes()
    return json.loads(blob), hashlib.sha256(blob).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            writer.writerow({
                key: json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value
                for key, value in row.items()
            })


def pairs(versions: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return sorted((version["key"], version["native_sha256"]) for version in versions)


def audit(page_path: Path, manifest_path: Path, annotations_path: Path, output: Path) -> dict[str, Any]:
    page, page_sha = read_json(page_path)
    manifest, manifest_sha = read_json(manifest_path)
    annotations, annotations_sha = read_json(annotations_path)
    output.mkdir(parents=True, exist_ok=True)

    page_map = {row["source_uid"]: row for row in page["items"]}
    final_map = {row["source_uid"]: row for row in manifest["items"]}
    annotated_map = {row["source_uid"]: row for row in annotations["items"]}
    failures: list[dict[str, Any]] = []
    for label, rows, index in (
        ("page", page["items"], page_map),
        ("final_manifest", manifest["items"], final_map),
        ("final_annotations", annotations["items"], annotated_map),
    ):
        if len(rows) != len(index):
            failures.append({"check": "unique_source_uid", "input": label})
    if manifest["parent_annotations_sha256"] != annotations_sha:
        failures.append({"check": "manifest_to_annotations_sha256"})

    accepted = {uid for uid, row in annotated_map.items() if row["status"] == "pass"}
    if accepted != set(final_map):
        failures.append({
            "check": "accepted_set_matches_manifest",
            "only_annotations": sorted(accepted - set(final_map)),
            "only_manifest": sorted(set(final_map) - accepted),
        })
    for index, row in enumerate(manifest["items"]):
        parent = annotated_map.get(row["source_uid"], {})
        for field in ("source_uid", "source_sha256", "native_sha256", "generation_version", "config_sha256", "status", "split"):
            if row.get(field) != parent.get(field):
                failures.append({"check": "final_record_binding", "index": index, "source_uid": row["source_uid"], "field": field})

    reviewer_rows = []
    user_rows = []
    metadata_examples = []
    for index, row in enumerate(annotations["items"]):
        reviewer_rows.append({
            "annotation_index": index,
            "source_uid": row["source_uid"],
            "source_sha256": row["source_sha256"],
            "native_sha256": row["native_sha256"],
            "generation_version": row["generation_version"],
            "status": row["status"],
            "reviewer": row.get("reviewer"),
            "reviewed_at": row.get("reviewed_at"),
            "has_human_choice": "human_choice" in row,
        })
        choice = row.get("human_choice")
        if choice:
            page_row = page_map.get(row["source_uid"])
            selected = next((v["native_sha256"] for v in choice["versions"] if v["key"] == choice["choice"]), None)
            user_rows.append({
                "annotation_index": index,
                "source_uid": row["source_uid"],
                "human_choice": choice["choice"],
                "human_choice_at": choice["updated_at"],
                "evidence_kind": choice.get("evidence_kind"),
                "source_hash_matches_page": bool(page_row and page_row["source_sha256"] == choice["source_sha256"]),
                "comparison_matches_page": bool(page_row and pairs(page_row["versions"]) == pairs(choice["versions"])),
                "human_selected_native_sha256": selected,
                "final_native_sha256": row["native_sha256"],
                "final_generation_version": row["generation_version"],
                "final_reviewer": row.get("reviewer"),
                "final_status": row["status"],
                "final_keeps_selected_native": selected == row["native_sha256"] if selected else None,
            })
        history = row.get("version_history")
        if isinstance(history, dict):
            versions = history.get("versions", [])
            by_native: dict[str, list[dict[str, Any]]] = {}
            for version in versions:
                by_native.setdefault(version["native_sha256"], []).append(version)
            for native, versions in by_native.items():
                identities = {(v.get("generation_version"), v.get("config_sha256")) for v in versions}
                if len(identities) > 1:
                    metadata_examples.append({
                        "annotation_index": index,
                        "source_uid": row["source_uid"],
                        "native_sha256": native,
                        "identities": [
                            {"generation_version": generation, "config_sha256": config}
                            for generation, config in sorted(identities)
                        ],
                    })

    lineage = []
    for index, row in enumerate(page["items"]):
        final = final_map.get(row["source_uid"])
        annotation = annotated_map.get(row["source_uid"])
        lineage.append({
            "page_index": index,
            "source_uid": row["source_uid"],
            "page_source_sha256": row["source_sha256"],
            "final_present": final is not None,
            "source_hash_equal": final["source_sha256"] == row["source_sha256"] if final else None,
            "page_native_hashes": {v["key"]: v["native_sha256"] for v in row["versions"]},
            "final_native_sha256": final["native_sha256"] if final else None,
            "final_matches_page_keys": [v["key"] for v in row["versions"] if final and v["native_sha256"] == final["native_sha256"]],
            "final_generation_version": final["generation_version"] if final else None,
            "final_annotation_status": annotation.get("status") if annotation else None,
            "final_annotation_reviewer": annotation.get("reviewer") if annotation else None,
        })

    summary = {
        "inputs": {
            "page": {"sha256": page_sha, "dataset_id": page["dataset_id"], "reported_counts": page["counts"]},
            "manifest": {"sha256": manifest_sha, "schema_version": manifest["schema_version"], "reported_images": manifest["images"], "reported_current_redo": manifest["current_redo"], "generation_status": manifest["generation_status"]},
            "annotations": {"sha256": annotations_sha, "dataset_id": annotations["dataset_id"], "reported_counts": annotations["counts"]},
        },
        "reviewer_counts_all": dict(Counter(row.get("reviewer", "<missing>") for row in annotations["items"])),
        "reviewer_counts_accepted": dict(Counter(row.get("reviewer", "<missing>") for row in annotations["items"] if row["status"] == "pass")),
        "reviewer_counts_redo": dict(Counter(row.get("reviewer", "<missing>") for row in annotations["items"] if row["status"] == "redo")),
        "page_uid_groups": dict(Counter(uid.split("/")[0] for uid in page_map)),
        "page_rows_in_final": sum(row["final_present"] for row in lineage),
        "page_rows_absent_final": sum(not row["final_present"] for row in lineage),
        "matching_source_hashes": sum(row["source_hash_equal"] is True for row in lineage),
        "final_matches_page_any": sum(bool(row["final_matches_page_keys"]) for row in lineage),
        "final_changed_native": sum(row["final_present"] and not row["final_matches_page_keys"] for row in lineage),
        "preserved_browser_exports": len(user_rows),
        "bound_fields": ["source_uid", "source_sha256", "native_sha256", "generation_version", "config_sha256", "status", "split"],
        "failures": failures,
    }
    write_json(output / "P318-evidence-audit.json", summary)
    write_csv(output / "P318-reviewer-rows.csv", reviewer_rows)
    write_csv(output / "P318-page-final-lineage.csv", lineage)
    write_json(output / "P318-preserved-user-choices.json", user_rows)
    write_json(output / "P318-identical-native-metadata.json", metadata_examples)
    write_json(output / "P318-real-history-export.json", {
        "schema_version": 1,
        "dataset_id": page["dataset_id"],
        "review_method": "reconstructed from preserved browser-export fields; not a new review",
        "reconstructed_from": {
            "annotations_sha256": annotations_sha,
            "field": "items[].human_choice",
            "matched_page_source_manifest_sha256": page["source_manifest_sha256"],
            "envelope_note": "dataset_id supplies the verified matching page context; the original browser envelope was not recovered, so its source_manifest_sha256 is not asserted on the legacy events",
        },
        "items": [],
        "history": [row["human_choice"] for row in annotations["items"] if row.get("human_choice")],
    })
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-data", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--annotations", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    summary = audit(args.page_data, args.manifest, args.annotations, args.output)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 2 if summary["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
