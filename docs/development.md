# Developer notes

> The full text of the previous front-page README: data counts, import and recovery, offline verification and the image-identity boundary. The front page now keeps only the overview and quick start.


Open `index.html` for the review app, `showcase.html` for the read-only identity tour, or `demo.html` for a standalone synthetic exercise. The production manifest contains **500 source comparisons**, with 500 old and 148 rerun candidates. This source package retains all 1,148 original repository display images, together with the original data.json and attribution records. New choices remain disabled until every image required by the current comparison loads successfully. Keyboard shortcuts and direct choice handlers use the same gate.

The newly supplied annotation source contains **1,250 current rows**: 1,162 pass and 88 redo. Counting its actual reviewer fields gives 1,156 Codex-labelled passes and 6 human-choice-labelled passes; all 88 redo rows are Codex-labelled. These are record attributions, not independent authentication of reviewers or visual re-review. The 500-page comparisons and 1,250 annotation pool have different denominators. Full raw-field and version-identity audit results accompany the handoff; page identities were not edited to force agreement.

## Import and recovery

- **Import annotations / 导入标注（整包检查）** validates every incoming record with the shared source/candidate validator, then normalizes the complete set and checks event collisions/history structure before committing. A bad tail leaves previous labels, journal and queue untouched. This path rejects unknown source identities while preserving valid historical candidate hashes.
- **Recover backup / 恢复备份（保留异常）** keeps P318's per-record journal recovery. Old source-hash comparisons may remain archived; malformed records remain quarantined. Invalid records do not become current choices. Recovery flags do not switch the ordinary-import path into a permissive mode.
- The same shared validator checks outbound queue entries and batches. A bad or not-yet-verifiable queue is held without an HTTP request; original browser-storage bytes remain available for diagnosis. A missing legacy `seen` index is rebuilt from validated pending entries and immutable batch/receipt entries, preventing the migration of one old action from creating a second upload. Old labels are not deleted to make a new import pass.

`tools/P318-recover.cjs` is the supplied original recovery CLI with one narrowly scoped change: all output JSON uses the existing credential sanitizer. `recover.cjs` preserves the earlier W04 single-file CLI interface.

```sh
node tools/P318-recover.cjs --dataset data.json --out /tmp/recovered [--test-data] backup.json
node recover.cjs --dataset data.json --out /tmp/recovered.json backup.json
```

Exit 0 means conflict-free recovery; 3 means inspect retained conflicts/quarantine; 2 means command/input error. Neither CLI contacts a remote service. Retain schema-2 backups and restore them with this reader; the old schema-1 reader cannot preserve the event journal.

## Offline verification

Node.js 24+, Python 3.10+ and their standard libraries suffice for the Node/CLI checks. Full browser checks additionally require already installed Python Playwright, Node Playwright and Chromium. Set `PLAYWRIGHT_MODULE` to an existing Node Playwright package path when it is outside normal module resolution. No npm installation or remote fetch is performed.

```sh
python verify.py --out /tmp/review-checks --browser /path/to/chromium
python verify.py --out /tmp/review-node-checks --no-browser
```

`--no-browser` explicitly records the browser step as skipped. `REVIEW_NODE` and `REVIEW_BROWSER_EXECUTABLE` can select existing runtimes. The browser suite intercepts loopback-origin requests and supplies labelled synthetic SVGs; external HTTP is aborted. Node HTTP/sync tests use in-memory responses and fake session values. None is a real teacher quality decision or production sync receipt. The report distinguishes 19 historical-defect controls, core/sync cases, CLI cases/named assertions, compatibility cases and browser checks instead of adding different units into one total.

Rebuild only the small standalone synthetic demonstration with `python scripts/build_demo.py`. It embeds the merged app, core and validator, sets `is_test=true`, uses separate storage, and has a policy forbidding network connections. It does not embed the sync module, repository configuration or credentials.

## Image identity and deployment boundary

`review_sha256` query parameters identify/cache a declared comparison. They do not hash the downloaded display bytes. Manifest `source_sha256` and `native_sha256` identify original bytes; the WebP derivatives need their own expected byte hashes and conversion provenance. Loading readiness does not establish native identity or visual quality. The included WebP files support the existing comparison UI; native-byte verification uses the separate original-image and derivation records.

Tokens remain in sessionStorage. All exports and recovery diagnostics strip credential fields. `config.js` preserves the repository target from the verified baseline commit and permits an explicit local override; `config.example.js` remains a placeholder example. This is a non-secret configuration value, not a stored token or a grant to synchronize. This handoff has no site publication or real GitHub writes.
