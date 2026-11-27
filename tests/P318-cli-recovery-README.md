# P318 offline CLI recovery regressions

Copy this directory into the repository as `tests/`. The new entry point uses Node built-ins and the existing `P318-test-support.cjs`; it makes no network request.

```bash
node tests/P318-cli-recovery-check.cjs --root . --output /tmp/P318-cli-regression
```

The repository must contain `data.json`, the core and the recovery CLI. The published layout is `P318-review-core.js` plus `tools/P318-recover.cjs`; the working source layout of `qwen-page/P318-review-core.js` plus `P318-recover.cjs` is also accepted. Output must be outside the repository. The output report is `P318-cli-recovery-regression.json`, with the actual CLI commands, input/source/output hashes and individual assertions. Exit 0 means all five cases passed and all tracked source/fixture bytes were unchanged; exit 1 means an assertion failed; exit 2 means an invocation or input error.

## Original input fixtures

| Fixture | Original evidence | Exact bytes / SHA-256 |
|---|---|---|
| `fixtures/P318-cli-history-queue-conflict.json` | Actual constructed browser import: one `old` history event and one `new` pending event with the same event ID | 4,006 / `ac0ffd9034d26779d9aa6519d26b0742b3376fbe98bda53b323640865561d46b` |
| `fixtures/P318-cli-legacy-corrupt-export.json` | Actual fixed-browser export containing the original malformed legacy queue string and an already quarantined malformed draft | 1,658 / `bf56bf33f730e2d8d25602ccfdd2b004e8a010e254b86a891e4ab373ecb6db0a` |
| `fixtures/P318-cli-real-seven-legacy-test.json` | Test derivative of the actual migrated seven-history export; original historical bindings are retained, test markers are set, and one matching pending record is synthetically copied from history | 25,344 / `58b7beb1f0fd27f06673be5a74326415e7ae1093f2eab7139e1639f9d5d517d6` |

All inputs remain `is_test: true`; the test calls the actual CLI with `--test-data`. They are recovery fixtures, not new human image-quality decisions. The first two fixture files retain their original bytes. The earlier browser export without a `legacy_queue.raw` field is deliberately not substituted for the second input: an input that already lost the string cannot establish whether the CLI preserves it.

The first case requires CLI exit 3, a reported queue/history disagreement, the incoming event in merged quarantine, the original `old` history and no conflicting pending upload. The second requires exit 3 for the already retained malformed draft, the exact malformed queue string once in merged recovered evidence, and no manufactured choices. Each case independently reopens all three CLI outputs.

Two additional cases derive from the first fixture and change only `pending[0].legacy` or both that flag and `history[0].legacy` to `true`. The untouched source fixture and each generated input receive separate hashes in the result. The required conflict behavior is identical: schema-2 entries cannot bypass history binding by declaring themselves legacy. The generated inputs are written only under `--output`.

The fifth case is a valid compatibility control. Its seven schema-2 legacy history records come from `evidence/P318-real-seven-cli/P318-merged-annotations.json`, original SHA-256 `63b373768aa95e6d38d17dab5cdc15ac498a4533aac42d273a99d77bcb05a9e5`. The fixture records the reconstruction SHA, all seven original `human_choice` pointers, a canonical hash of the original history and the exact changed fields. Reverting only the explicit test markers must reproduce that original history hash. One synthetic pending event copies the first test-marked history event exactly; it does not claim that a historical upload existed. The CLI must accept this matching schema-2 legacy entry, preserve all seven historical bindings and keep the one pending record. Current-image count is deliberately not fixed, because a current manifest can archive a valid older comparison.

The five cases contain **33 named assertions**: the original conflict case has 7, malformed raw preservation has 6, the two flag-only variants have 7 each, and the real-history control has 6. These counts are separate from case counts and setup validation. The recorded comparison using core `55ec8483…` passes 3/5 cases and 25/33 assertions; only the two flag variants fail. With core `31c8cfab…`, all 5/5 cases and 33/33 assertions pass; the recovery CLI bytes are unchanged. Both runs retain their source/input hashes and produce no actual network requests.

These five cases do not replace browser recovery, continuous-session or final source-package checks. The separate `P318-batch-path-probe.cjs` retains its documented explicit source/file arguments and covers only its two original path inputs, one stored-queue branch and the five original batches.
