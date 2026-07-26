# SUPERSEDED — 未实施即废弃

本提案 **从未实施**（66 项任务全部未开始），已被 `add-mvp1-backend-flow` 取代。

归档而非删除的原因：其中的 Prisma schema 字段清单、REST 端点表、内容安全管道分层仍有参考价值，可在新提案实现时对照取用。

## 为什么被取代

2026-07-26 的一轮流程重新推导中，本提案有 13 处设计被推翻。推翻的依据大部分是**实测数据**，而非重新讨论：

| # | 本提案的设计 | 被改成 | 推翻依据 |
|---|---|---|---|
| 1 | `full_analysis` 一个 job 一口气跑完 | 拆成 3 个 job | 流程中间有两次必须的同步用户选择，物理上不可能连续执行 |
| 2 | 目标图 = 基准图 + 已完成 ChangeManifestEntry | 额外 + 本阶段 core 任务的计划变化 | 按原设计，阶段 N 解锁瞬间账本里没有阶段 N 的条目，目标图与阶段 N-1 完全相同，"目标"二字不成立 |
| 3 | 阶段 1-3 任务清单懒生成（省成本） | 一次全生成 | 阶段落位改为数据驱动后，懒生成需要调 4 次 LLM，比一次全生成贵约 4 倍 |
| 4 | 加权打分公式决定阶段分配 | `applicable_stage_range` 定阶段，打分只定 core/optional + 排序 | 阶段是时间尺度（任务固有属性），不是优先级的函数；「健身减脂」打分再高也塞不进"当天 10-30 分钟"的阶段 0 |
| 5 | 脸型由 VisionAnalysisProvider 判断 | 客户端 MediaPipe 几何测量 + 用户确认 | 实测 10 张图，Zhipu 与 Qwen 对 `face_shape` 的一致率仅 2/10 |
| 6 | 发型/穿搭各自独立出候选、各选一个 | 风格优先 + 发型→穿搭两步约束选择 | 独立选择会产生不协调组合（寸头 + 文艺针织衫） |
| 7 | 阶段 0 也生成目标图 | 阶段 0 不生成 | 阶段 0 全是仪容清理类变化，图上视觉差异极小，白花 ¥0.2 还制造"这就完了"的失望 |
| 8 | 穿搭目标图用 swap-outfit（¥1/次） | 品类级 img2img（¥0.2/次） | 实测三套穿搭品类级 img2img 全部成功，质量接近真实服装摄影，无需服装图 |
| 9 | `AnalysisJob` 仅 completed / failed | 新增部分成功状态 | 渐进式推送下"全或无"自相矛盾——已推送给用户的图无法收回 |
| 10 | 无对话入口 | 新增（可写，付费门槛 + 独立技术限流） | |
| 11 | `candidate_style_tags: string[]` | 每个候选需带自己的 `change_description` | 选中后要直接落为本阶段计划变化，光有 tag 写不出变化描述 |
| 12 | 无风格数据结构 | 新增 `StyleProfile`（风格向量 + 兼容性计算） | 协调性必须编码在数据里，不能靠 LLM 审美判断 |
| 13 | 未考虑供应商并发限制 | 图片生成并发=1，全局串行，纳入容量设计 | 实测 6 个并发提交，5 个被 `code 50430 API Concurrent Limit` 拒绝 |

## 仍然有效、已被新提案继承的部分

- Provider 按能力拆分的抽象（`VisionAnalysisProvider` / `ImageEditProvider` / …）
- `evidence_basis` 三档（`visual_detected` / `self_reported` / `general_best_practice`）作为打分前的硬过滤
- `general_best_practice` 永不可为 `priority=core`，且文案须用建议语气
- 人工维护的种子数据原则（`CandidateTaskCatalog` / `StyleReferenceGuide` 防 LLM 幻觉）
- 匿名 `device_session_id` 身份方案
- BullMQ 三队列隔离（`moderation` / `text-analysis` / `image-generation`）
- 异步分级数据删除
- AI 生成内容标识（显式 + 隐式）
- `AppearancePlan` 每用户单条活跃记录、`plan_version` 原地递增
