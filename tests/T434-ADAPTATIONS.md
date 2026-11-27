# T434 对 P318 的测试接口适配

原始 `input/T434/tests` 和 37 个清单输入保持字节不变。此目录的 13 项测试是单独的适配层，不冒称原字节测试。原字节 T434 测试已在附带旧基线控制上 3/13，通过原 T434 patch 的控制上 13/13；日志在 `../test_review/`。模型/真实 GitHub/API 均未调用。

运行（输出放本目录外或本目录日志，不写 merged）：

```sh
REVIEW_SOURCE_ROOT=/tmp/w04_review_merge_20261127/merged \
NODE_OPTIONS=--require=/tmp/w04_review_merge_20261127/test_review/deny-network.cjs \
node --test tests/review-validation.test.cjs
```

## 统一 harness 变化

- 保留原 fixtures 原字节，以 `REVIEW_SOURCE_ROOT` 只读加载实际共享 validator、P318 core、sync、app。未替换业务函数。
- P318 的 `window=globalThis`、动态 dataset、`QWEN_REVIEW_CONFIG.fetch`、test token 命名空间和 Storage `length/key` 为真实接口；将原 doubles 补齐，而不是将业务行为改成测试答案。
- DOM 增加实际页面所需 options、classList、querySelector、focus，IMG 在 microtask 中产生合成成功 load，并有 complete/naturalWidth/decode。这里只用于 validator 契约；加载失败与快速切换仍须真实浏览器单独覆盖。
- `import()` 显式走新“导入标注” `#labels-file`。原 P318 `#file/importData` 是“恢复备份”逐条隔离入口，另由原 P318 测试覆盖；不靠数据中的 legacy/is_test/schema 标志偷偷切换安全语义。
- 未连接 sync 的 stub 补 configure、legacyInfo、legacyPending、backup 等真实生命周期接口。连接的用真实 sync，HTTP 是原 fixture 内存服务器；Node socket 入口额外禁止网络。

## 逐项语义与适配

| 原测试 | 必须保留的语义 | 适配 |
|---|---|---|
| 1 absent version | 缺失被选候选不能生成当前结果、Storage 不变、无 enqueue | 只改输入入口；断言不变 |
| 2 malformed tail | 已有标签不变、整个非法导入零写入、零 enqueue | `labels` 内部对象改为实际 `exportData().history` 的前后精确比较 |
| 3 source/slot/hash | 六种原坏输入均拒绝、无历史、无写入、无 enqueue | 原六变体和断言不变 |
| 4 old/new/redo | 三种合法选择 save/reload/export/sync，确认 1 次、仅 1 PUT、凭据不导出 | 原断言不变；真实 P318 sync config/token 生命周期 |
| 5 historical native | 旧 native 仍保留历史、不成为 current、能同步 | 只投影 key/native 两字段；P318 另加 generation_version。双方按 key 排序后精确比较，契合 P318 R01 的顺序无关 contract；不忽略槽位/哈希 |
| 6 invented native | 格式有效但非当前 native 仅作为历史，不变成 current | 原断言不变 |
| 7 bad cached | 坏原文可诊断，排除 history/current，不发 HTTP，不改旧键 | 原断言不变，生产 diagnostics 从隔离/恢复证据只读投影 |
| 8 invalid roots | null/array/坏 JSON 原键不动且可导出，后续合法选择可保存 | 原三个输入和断言不变 |
| 9 invalid queue/batch | 两个原分支零 HTTP/零写入且 pending 证据可读 | 原坏输入和断言不变 |
| 10 delayed manifest | 延迟前不写/不发、未 ready；释放后可正常确认 | P318 journal 尚未创建，改读真实共享 validator.isReady，不调用不存在的 export；其余原断言不变 |
| 11 warning clear | 清单未就绪出现 transient retry，空队列就绪后警告清除 | 就绪状态接受原 saved 或 P318 confirmed，并额外要求 summary.error 为 null；未就绪 retry 断言不变 |
| 12 direct enqueue | 直接调用也拒绝非法候选，零 pending/写入/HTTP | 给坏候选补合法 event_id，避免仅因缺 ID 被拒；新增 queued=false/validation_failed=true 断言 |
| 13 script order | 共享 validator 必须先于 sync 和 app | 路径改只读 sourceRoot，原顺序断言不变 |

## 结果归档

`first-run.log` 是生产初版的真实结果：10/13 通过、3 项失败，未覆盖掉。第 5 项是 canonical order 的接口适配；第 9 项是诊断 pending 投影不完整；第 11 项是加载前缺少 retry 状态。最终结果另存，不能将首轮改写为通过。
