# Qwen image review

A static GitHub Pages tool: tap the preferred cartoon or choose both redo. Secondary controls are collected under More.

## Durable autosave

Connect a fine-grained GitHub token restricted to this repository with Contents read/write. The token is stored in the current tab session; published files and annotation exports contain image/choice data and receipts. Connection is checked with a real write to the annotations branch. Each five actions are stored in an immutable JSON batch on that branch and verified by reading it back. Failed or interrupted uploads remain in the browser queue and retry idempotently. Web Locks coordinate multiple tabs.

The annotations branch stores data independently of the main Pages branch. Batch storage and serving use GitHub; the annotation workflow operates from the browser. New source/rerun display-image updates use the existing local publishing task.

Original source UID, source SHA256, compared native result hashes, choice and timestamp accompany every record. Previous comparison versions remain in export history. Verification batches have a separate folder and is_test marker.

500 source/old-result pairs and incremental148 reruns. Display copies use EXIF display orientation, bounding box1280px and WebP93; original files remain in the project archive. Source authors, source links and per-image licenses are in ATTRIBUTIONS.json.
