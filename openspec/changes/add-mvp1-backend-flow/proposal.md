## Why

`add-mvp1-core-flow`（已归档为 `archive/2026-07-26-superseded-add-mvp1-core-flow`）是在没有任何供应商实测数据的情况下写出来的，66 项任务未开始一项，而其中 13 处设计被后续实测推翻——包括「目标图代表哪个时间点」这类逻辑上自相矛盾的问题（阶段解锁瞬间目标图与上阶段完全相同，"目标"不成立）。继续按那份 spec 实施会把这些错误固化进代码。

本提案是重新推导后的完整后端业务流程。与前一份的根本差别：**每一条关键设计都由实测数据或逻辑推演支撑，而不是文档上的合理猜测**。推导过程中做了 8 轮针对性实测（多变化累加、品类级穿搭、证件照转全身、并发上限、脸型识别一致性、发量识别可靠性等），其中 3 项测出与原设计相反的结论。

## What Changes

**流程结构**：`full_analysis` 拆解为 `initial_analysis` → `outfit_preview_generation` → `plan_materialization` 三个 job，因为流程中间有两次必须的同步用户选择（选发型、选穿搭）。`stage_unlock_generation` 职责收窄为只生成目标图。`progress_recheck` 从锦上添花升级为账本校准机制。

**推荐模型**：从「发型/穿搭各自独立出候选」改为「风格优先 + 两步约束选择」。风格协调性由 `StyleProfile` 的风格向量（正式度/成熟度/张扬度/维护成本）做确定性硬过滤保证，LLM 只在已保证兼容的集合内挑选和写文案——不允许 LLM 判断"什么和什么搭"。发型（不可逆）先选，穿搭（可逆）后选且候选集受发型约束。

**几何测量归客户端**：脸型、三庭五眼等几何判断改由客户端 MediaPipe 的 `FaceMetrics` 用确定性规则给出（实测两家 vision provider 对 `face_shape` 一致率仅 2/10），云端视觉模型只负责风格/美学层面的语义判断。发际线/发量按客户端调研报告的置信度分级矩阵组合使用。

**目标图语义**：目标图 = 基准照片 + 已完成变化账本 + **本阶段 core 任务的计划变化**，`seed` 按用户固定以保证四个阶段的图是同一个人的连续演变。阶段 0 不生成目标图。

**容量约束纳入设计**：图片生成供应商并发上限为 1（实测），全局串行、每张 13 秒，是硬吞吐天花板。渐进式推送、候选数量、部分失败降级都由这个约束推导而来。

## Impact

- 归档 `add-mvp1-core-flow`，其 13 处被推翻的设计与推翻依据记录在归档目录的 `SUPERSEDED.md`
- 新增 6 个 capability：`intake-and-measurement` / `style-recommendation` / `preview-generation` / `plan-materialization` / `stage-progression` / `plan-revision`
- 新增数据结构 `StyleProfile`；`StyleReferenceGuide` 增加 `requires_hair_volume` 与 `covers_forehead` 约束字段；`AppearanceProfile` 增加体型细项与发量自评；问卷增加脱发困扰自报题
- 依赖 `add-appearance-agent-foundation` 已验证的 provider 层（该提案继续有效，本提案在其之上构建）
- 本提案不含内容安全供应商选型（`ImageModerationProvider` / `TextModerationProvider` 至今一个都没选），也不含支付
