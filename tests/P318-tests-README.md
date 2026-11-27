# P318 可搬移的独立检查

将本目录内容放在发布项目的 `tests/` 中。运行依赖 Node.js 18 或更新版本、Python 3.10 或更新版本及它们的标准库；不安装 npm 或 Python 包。本组检查不调用真实 GitHub，也不需要令牌。

## 目录与输入

```text
repo/
  app.js
  sync.js
  P318-review-core.js
  data.json
  tests/
    P318-run-unit-checks.cjs
    P318-test-support.cjs
    P318-baseline-replay.cjs
    P318-core-review.cjs
    P318-sync-review.cjs
    P318-history-queue-conflict-check.cjs
    P318-legacy-corrupt-backup-check.cjs
    P318-test-data-separation.cjs
    P318-cli-recovery-check.cjs
    P318-batch-path-probe.cjs
    P318-inspect-snapshot.py
    P318-make-legacy500.py
    baseline/
      app.js
      sync.js
    fixtures/
      P318-qwen-annotation-batches.json
```

`tests/baseline/` 中保存附件原始源码；根目录放修后代码与实际 500 项 `data.json`。批次 fixture 保存附件原始 `{path,data}` 数组，五个批次均为 verification 数据，不能用来推算人工完成数。

## 最短运行命令

在项目根目录运行下列命令，输出目录必须位于项目外：

```bash
node tests/P318-run-unit-checks.cjs --output /tmp/P318-check-results
```

也可从任何目录明确指定项目：

```bash
node /path/to/repo/tests/P318-run-unit-checks.cjs --root /path/to/repo --output /tmp/P318-check-results
```

`--root` 默认取脚本所在 `tests/` 的上级，不依赖当前工作目录；`--python /path/to/python3` 可指定 Python 解释器。`--output` 必须给出，所有生成的 JSON 都只写到该目录。统一入口在运行前后比对输入文件清单、大小和 SHA-256，并将检查结果写到 `P318-portable-suite.json`。

## 结果与退出码

| 脚本 | 既有检查与预期结果 | 输出 |
|---|---|---|
| `P318-baseline-replay.cjs` | 19 个原行为断言；既包含已确认缺口，也包含原有正确幂等行为 | `P318-baseline-results.json` |
| `P318-core-review.cjs` | 18 个核心反向检查，全部通过 | `P318-core-review-results.json` |
| `P318-sync-review.cjs` | 9 个同步检查；S09 覆盖两包及同包 batch ID 冲突、已确认 event ID 在新批次中冲突，要求拒入且原队列不变 | `P318-sync-review-results.json` |
| `P318-history-queue-conflict-check.cjs` | 实际 app 导入函数与 core/sync；同一事件 ID 的 history old / queue new，现代 queue 无对应 history、仅 pending 标 legacy 和两方都标 legacy 四个分支，均须明确冲突 | `P318-history-queue-conflict-result.json`、确定输入 JSON |
| `P318-legacy-corrupt-backup-check.cjs` | 实际初始化→导出→空 Storage 导入→新 realm 刷新再导出；两份坏原文都须保全，原键不变且重复证据不增生 | `P318-legacy-corrupt-backup-result.json`、实际导出 JSON |
| `P318-test-data-separation.cjs` | 测试导出与同源测试 journal 均不产生正式当前选择 | `P318-test-data-separation-results.json` |
| `P318-cli-recovery-check.cjs` | 5 例、33 条具名检查：两个原输入、两个 legacy 标记反例及真实七条历史的合法控制 | `P318-cli-recovery-regression.json` |
| `P318-batch-path-probe.cjs` | 4 项闭合检查：两个批次路径反例、坏 queue client ID、原五批无修改适配 | `P318-batch-path-probe.json` |
| `P318-inspect-snapshot.py` | 逐行检查实际 500 来源、648 版本和五个 verification 批次；记录字段与内容匹配结果 | `P318-snapshot-inspection.json` |
| `P318-make-legacy500.py` | 生成 500 次明确的合成选择，保存原始 draft/pending/seen 形状及精确序列化大小 | `P318-legacy500-input.json`、`P318-legacy500-size.json` |

统一入口退出码 `0` 表示十个脚本成功退出且输入文件完全未变；`1` 表示断言、运行或输入完整性检查失败；`2` 表示参数错误。除路径探针外，单个 JavaScript 检查可使用相同的 `--root`、`--output` 参数直接运行；路径探针的独立参数以 `node tests/P318-batch-path-probe.cjs --help` 为准，统一入口会传入准确路径。两个 Python 工具使用 `python3 tests/<脚本名> --root <repo> --output <目录>`。Python 工具成功退出表示完成检查或 fixture 生成，逐项事实保存在 JSON 中。

此处的 VM 与内存 Storage 检查验证应用逻辑；真实浏览器、WebStorage 配额、HTTP 图片缓存和屏幕状态由另附浏览器检查负责。旧 500 项 fixture 是测试输入，迁移后 snapshot 与 queue_event 可形成 1,000 条证据记录，它们仍只源于 500 次合成选择。恢复 CLI 位于 `tools/P318-recover.cjs`，使用方式见 `docs/P318-annotation-contract.md`。

## 旧读者兼容演练

**新版备份必须由新读者恢复。** `node tests/P318-old-reader-check.cjs --output ../P318-old-reader` 复用原版隔离环境：原 schema 1 自己导入的控制有效，而实际 schema 2 合并输入被旧页折叠且没有当前选择。八条具名检查验证该采用风险；它是主交付 `P318-run.py check` 的单独步骤，不计入上述十脚本门禁。输入为明确的测试导出，原 app.js 字节未改。

## 原格式队列恢复与拒绝控制

**同一原批次的证据应在导入即刻和刷新后形成相同历史。** 以下两条命令分别使用附件第 1、3 批，实际调用 CLI 导出后只损坏一个 history 时间字段，检查页面真实导入函数、启动桥接和 CLI。两批分别没有／具有外层 manifest 声明，修后均为五条历史、五个当前选择、一条隔离和五条原 pending，批次内容保持不变。

```bash
node tests/P318-legacy-queue-recovery-check.cjs --batch-index 0 --output ../P318-legacy-unknown
node tests/P318-legacy-queue-recovery-check.cjs --batch-index 2 --output ../P318-legacy-known
```

第 1 批分支另检查同原 ID 的 pending 与 batch 选择矛盾：CLI 返回 3，原文保留在隔离区，矛盾 pending 不先形成第五个当前选择。两个分支分别含 22 与 18 条具名检查，成功退出 0。它们是交付主入口 `P318-run.py check` 的独立步骤，不计入上述十脚本。`demo/P318-legacy-queue-browser-check.py` 用相同生成输入完成实际文件导入、下载和刷新，参数见主运行说明。
