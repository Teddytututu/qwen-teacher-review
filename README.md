# Human cartoon annotations

This branch stores browser-uploaded annotation batches for the Qwen review site. Each batch identifies source UID, original source SHA256, compared result hashes, selection and timestamp. Batch files are immutable and grouped by browser session/date. Verification batches use their own folder and is_test marker.

The public GitHub Pages frontend lives on main. This annotations branch contains review data and has a separate commit history.
