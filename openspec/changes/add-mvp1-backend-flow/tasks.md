> 范围：仅 `server/` 目录。客户端任务由客户端团队在 `docs/mvp-web-ui-design.md` 及其独立清单中跟踪。
> 依赖：`add-appearance-agent-foundation`（provider 层已验证可用）已完成，本清单在其之上构建。

## 0. 前置阻塞项
- [~] 0.1 `ImageModerationProvider` 供应商选型 — **本地 MVP 阶段搁置**（不接真实内容安全服务，S1 只跑确定性红线规则）。上线前必须补，届时首选阿里云内容安全（`ALIYUN_GREEN_*` 配置位已预留，新用户 31 天内每日 3000 张免费额度）
- [~] 0.2 `TextModerationProvider` 供应商选型 — 同上搁置
- [x] 0.3 风格向量维度、协调阈值、双审美评分结构 — 落地为 `src/features/appearance-agent/data/styleProfile.ts`（四维向量 + 阈值 ≤3 + `femaleAppeal`/`maleSelfAppeal` 各带 source/confidence/rationale + 兼容组合生成 + 落差暴露判定）。数据本体故意留空待调研填充，不放占位假数据
- [→] 0.4 生产风格数据：发型 20-30 条 + 穿搭品类 30-50 条 — **调研计划已委派 subagent 编写**，产出 `docs/style-data-research-plan.md`，后续由其他 agent 按计划执行
- [x] 0.5 领域词库 — 落地为 `src/features/appearance-agent/data/domainLexicon.ts`。采用「敏感部位 × 物理改变动词」共现判定而非整短语匹配（中文允许任意插入与近义替换，整短语匹配漏放率高）；含 `VISUAL_EFFECT_ONLY` 白名单确保"显小脸/显高穿搭"这类核心业务不被误杀；18/18 行为测试通过
- [x] 0.6 对话 API 形态 — **多轮，但只存结构化决策摘要，不存对话原文**。跨轮需要记住的是"已确认的决策"（选了什么风格、拒绝了哪个方向及原因），而方案当前状态本来就在 `AppearancePlan` 里；不存原文同时规避了对话内容的隐私删除负担

> 图例：`[~]` 已知并有意搁置 `[→]` 已委派他人

## 1. 项目脚手架
- [x] 1.1 Fastify 应用骨架 — `src/app/server.ts` 工厂 + `src/routes/health.ts`（health check **真实探测 DB/Redis** 而非只返 200，并暴露 image-generation 并发数供运维核对）
- [x] 1.2 Prisma 接入 PostgreSQL，初始 `schema.prisma`
- [x] 1.3 Redis + BullMQ 三队列 — `src/lib/queues.ts`，各队列独立并发度
- [x] 1.4 `image-generation` 并发=1 队列级 limiter — 对真实 Redis 验证：6 个任务最大同时在跑=1、耗时 6.4s ≥ limiter 下界、完成顺序=提交顺序（故提交必须按匹配度降序）
- [x] 1.5 OSS 改为预签名 URL 形态 — `createPresignedUploadUrl`(客户端直传 PUT) / `createPresignedReadUrl`(短时 GET，也用于给供应商抓输入图)，前缀按 raw/generated/derived-features 隔离；实测直传与读回均成功。⚠️ **Bucket 当前仍是公共读（无签名访问返回 200），上线前必须在控制台改为私有**——代码已就绪，这是控制台动作
- [x] 1.6 依赖注入 — `src/app/container.ts` 为唯一组装根，经 Fastify `decorate` 注入；`withProviders:false` 让纯基础设施测试不因缺 AI key 而失败
- [x] 1.7 进程分离 — `src/index.ts`(API) / `src/worker.ts`(worker)，`WORKER_QUEUES` 选择消费队列；已记录部署约束：image-generation 因账号级并发=1 只能单副本

## 2. 数据模型
- [x] 2.1 `User`（`phone` 可空、`device_session_id`、`birth_date`、`age_confirmed_18plus`）
- [x] 2.2 `ConsentRecord`
- [x] 2.3 `AppearanceProfile` — 新增体型细项（肩宽/胸围/腰围/腿围，均可空）、`exercise_habit`、发量自评；`hair_loss_concern` 保留
- [x] 2.4 `Event`
- [x] 2.5 `UserPhoto`（`photo_type` 含 `full_body`、`face_metrics` JSON、`moderation_status`、`deletion_status`）
- [x] 2.6 **`StyleProfile`（新）** — 发型/穿搭条目 + 四维风格向量 + 适配条件
- [x] 2.7 `StyleReferenceGuide` — 新增 `requires_hair_volume`(low/medium/high)、`covers_forehead`(bool)
- [x] 2.8 `CandidateTaskCatalog`（非风格领域：仪容/护肤/健身/体态；含 `applicable_stage_range`、`evidence_basis`、`is_recommended`、`exclusion_reason`）
- [x] 2.9 `AppearancePlan` — 新增 `generation_seed`（per-user 固定 seed）、`selected_hair_style_tag`、`selected_outfit_combo_id`
- [x] 2.10 `Stage`
- [x] 2.11 `StageTask` — `guided_selection` 的候选改为 `[{style_tag, change_description}]` 结构（不再是 tag 字符串数组）
- [x] 2.12 `ChangeManifestEntry` — 新增 `verification_status`（unverified/verified/rolled_back，供 `progress_recheck` 校准）
- [x] 2.13 `TargetImage`（`baseline_photo_id`、`manifest_snapshot`、`planned_changes_snapshot`、`quality_check_status`、`consumed_weekly_quota`）
- [x] 2.14 `AnalysisJob` — `job_type` 六种；`status` 新增部分成功态
- [x] 2.15 `ProviderCallLog` — 把 `add-appearance-agent-foundation` 的文件版 `taskLedger` 迁到 Postgres（对外接口不变）
- [x] 2.16 `WorkflowRun`、`Feedback`
- [x] 2.17 首次 migration

## 3. 匿名会话与采集（spec: intake-and-measurement）
- [x] 3.1 `POST /auth/device-session` 幂等签发 + 长期 Cookie — 实测重复调用复用同一 session 且库中只有一条 User
- [x] 3.2 session hook — 解析 Cookie（兼容 `X-Device-Session` 头作 localStorage 兜底），挂 `req.currentUser`；**刻意不隐式签发**，否则任何探测请求都会造一个 User
- [x] 3.3 `POST /questionnaire/basic` / `/full` + zod 校验（含脱发自报题、体型细项）；校验失败统一转 400 带字段级错误，不漏成 500
- [x] 3.4 结构性矛盾校验 — BMI 越界 / 体脂与运动习惯矛盾 / 腰胸填反 / 发量自评与脱发困扰冲突；**检出但不阻断保存**（避免用户白填一遍）
- [x] 3.5 `POST /photos/consent` 版本化存证（含 sourceIp）
- [x] 3.6 `POST /photos/upload-url`(预签名直传) + `POST /photos`(上传完成回调登记 + 落库 face_metrics)。只有收到回调才登记，避免失败直传留下指向空对象的记录
- [x] 3.7 `GET /face-shape/computed`(带 confidence + 支撑比值) + `POST /face-shape/confirm`；实测用户修正值覆盖计算值（computed=oblong → confirmed=square）
- [x] 3.8 `POST /intake/hair-intent` — 显式二选一 gate，选"有"才收自由输入并过第一层词库审核；三条路径（红线阻断/脱离范畴/正常）均验证通过

## 4. 双层审核（spec: intake-and-measurement）
- [x] 4.1 第一层词库确定性匹配 — 已接入 `/intake/hair-intent`，红线命中即终止不进第二层
- [x] 4.2 第二层 LLM 越界审核 — `InputReviewProvider`(DeepSeek) 已接入 `/intake/hair-intent` 并对真实 LLM 验证（8/8）。**实施中修掉一个分层缺陷**：原先把 `out_of_domain` 当终止条件，导致「眼睛看起来大一点」「想要混血感的长相」这类越界但用视觉措辞的输入被判为「没太理解」而跳过第二层——根因是让弱信号（词库必然不全）抢在强检查之前终止。现在只有 `blocked` 终止，其余一律交第二层判「真无关/有关但越界/词库没收」。第二层不可用时按第一层结果分别降级
- [x] 4.3 硬编码红线 — 「敏感部位 × 物理改变动词」共现判定 + `VISUAL_EFFECT_ONLY` 白名单保护正当视觉修饰请求；红线优先于领域命中
- [x] 4.4 `style_tag` 归一化 — 命中用目录审核文案；未命中但过审则返回 `labelAsUserSpecified: true` 走标注路径。两条路径均验证
- [~] 4.5 `ImageModerationProvider` 接入 — **阻塞于 0.1（已搁置）**，S1 当前如实返回 `completed_partial` 并写明缺口
- [~] 4.6 `TextModerationProvider` 接入 — **阻塞于 0.2（已搁置）**

## 5. Step 实现（可独立调用 + 可独立重试）
- [x] 5.1 `S1 moderate-input` — 确定性红线层已实现并接入；图片审核缺失**如实标为 completed_partial 并写明缺口原因**，不假装通过
- [x] 5.2 `S2 analyze-vision` — 几何只**读取**客户端 faceMetrics（不重新判断），云端 prompt 明确要求「不要判断脸型或几何比例」；用户确认值覆盖计算值；语义调用失败时降级为部分成功而非归零；给供应商的是短时预签名 URL
- [x] 5.3 `S3 recommend` 确定性硬过滤 — 脸型适配 + 发际线/发量组合规则串联，输出 `filterTrace` 审计轨迹（实测 5→4→2）；风格数据未就绪时标记 `dataReady:false` 而非返回空数组
- [x] 5.4 `S3` 排序由**固定加权公式**给出（`weightedAppeal` 按 plan.femaleAppealWeight），不是 LLM 排的；被确定性过滤掉的候选 LLM 完全接触不到（已断言验证）
- [x] 5.5 `S3` 用户意向分支 — 命中目录则带上双审美落差供对比；未命中则 `labelAsUserSpecified:true` 走标注路径。对抗式评审工具复用 add-appearance-agent-foundation，接线待 S4 完成后串联
- [x] 5.6 `S4 render-previews` — **串行 for 循环是刻意的**（并发=1 硬约束，实测并发提交会被 code 50430 拒）；完成顺序恒等于提交顺序，故提交按匹配度降序保证第一张最推荐；每出一张回写 `job.partialResult` 供客户端增量渲染；生成结果回存自有 OSS（供应商链接 24h 失效，目标图要长期可见）
- [x] 5.7 `S4' render-outfit-previews` — 有全身照走本人生成；无全身照**不造全身照**（实测身份漂移严重，加体型描述词更甚），降级为文字+示意图并明确告知解锁方式。已断言降级模式零生成消耗
- [x] 5.8 `S5 materialize-plan` — 落位读 `applicableStageRange` 取范围内最早阶段，**与打分完全无关**（已断言 visualBenefit=10 的减脂训练仍落阶段3）；阶段内加权公式定 core/optional + sortOrder；`general_best_practice` 分再高也强制 optional（已断言分=10 仍 optional，但排序仍在最前——门槛只管 core 资格不管排序）；阶段0 无目标图
- [x] 5.9 `runWithSingleRetry` — 失败重试一次后放弃（与既有 quality_checking 同口径，不引入第二套策略）；`StepOutcome` 把 completed_partial 做成一等公民。已断言「两次都失败则放弃」不会无限重试

## 6. 发际线/发量组合规则（spec: style-recommendation）
- [x] 6.1 强约束（后移+薄）→ 排除 `requires_hair_volume=high` + 要求遮额。实测过滤 5 个候选保留 2 个
- [x] 6.2 中约束（仅后移，实测误报率 0/17）→ 只排 `covers_forehead=false`，不排高发量需求
- [x] 6.3 仅 `volume=thin` → **不施加任何约束**（实测短发者被误判为 thin，据此过滤会误伤大量短发用户）。已单独断言验证
- [x] 6.4 `occluded` → `needsCloudFallback=true` 挂起；若有自报脱发/发量少则自报补位施加中约束
- [x] 6.5 自报与视觉交叉验证 — 视觉与自报取更保守一方；`evidenceBasis` 区分 visual_detected / self_reported / visual_and_self_reported
- [x] 6.6 合规文案守卫 — 全部约束文案均为造型可行性口径；测试自动扫描诊断性词汇（脱发/秃/病/症状/诊断/治疗）确保不出现断言性表述

## 7. Job 编排
- [x] 7.1 `AnalysisJob` 仓储 + 状态机 — **状态集按 job_type 收窄**（前一份 spec 让 4 种 job 共用一条线性状态机，`input_moderating` 对多数 job 是空转）；拒绝回退（重跑应新建 job 而非复用）；终态不可再跃迁；非法跃迁**返回失败而非抛异常**（worker 里一个非法跃迁不该让 job 崩掉，但要可观察）；`completed_partial` 与 `completed` 严格区分
- [x] 7.2 `POST /analysis-jobs` — 完整性校验**逐项说明缺什么**（questionnaire/consent/frontPhoto），不是笼统「数据不完整」；**在途 job 复用而非重复入队**（重复触发会白烧图片钱）
- [x] 7.3 `GET /analysis-jobs/:id` — 非终态即可读部分结果，已断言「文字推荐先到、图片逐张追加且带剩余待生成数」；返回 `expectedFlow` 供客户端算进度；他人 job 返回 403
- [x] 7.4 `POST /plans/:id/outfit-previews` — **未选发型时 422 拒绝**（决策 3：穿搭候选集由发型过滤，没选发型无从生成）
- [x] 7.5 `POST /plans/:id/materialize` — 同样校验发型已选定
- [x] 7.6 `stage_unlock_generation` — 阶段解锁后**追加**目标图生成 job；解锁本身已在状态更新时完成，**不受目标图生成阻塞**（目标图是激励物不是门槛）
- [x] 7.7 `POST /plans/:id/target-images/regenerate` — MVP1 不设计费 gate，但有**独立于计费的容量限流**（每小时 3 次，保护并发=1 的全局串行队列；支付上线后仍保留）。已断言连点触发 429
- [x] 7.8 `POST /plans/:id/recheck` — 接收进度照片入队，校准逻辑在 worker 侧（tasks 9.x）
- [x] 7.9 `WorkflowRun` 持久化 — 每次目标图生成落一条（成本按 ¥0.2×实际调用次数算，**重试也计费**；含延迟、重试次数、供应商、质量检查结果）。已断言失败路径也留下记录（cost=¥0.4 retry=1）

## 8. 方案与阶段推进（spec: plan-materialization / stage-progression）
- [x] 8.1 `GET /plans/:id` + `/plans/current` — 一次返回全部四阶段任务（决策 8 后不再需要「未生成阶段只给骨架」的占位逻辑）；`coreProgress` 实时算出不读缓存；每个任务带 `skippable` 标记，前端不必给出点了就报错的按钮
- [x] 8.2 任务状态更新 — 核心任务跳过返回 422 `core_not_skippable`（理由不是「规则如此」：目标图按 core 计划变化生成，跳过会让图与计划脱节）；`guided_selection` 未选定就标完成也被拒（写不出正确账本）
- [x] 8.3 完成即写账本 — 原样复制任务生成时预写的 `changeDescription`，**无 LLM 调用**；`guided_selection` 用**选中候选**的描述而非任务级占位；默认 `unverified` 等 progress_recheck 校准
- [x] 8.4 guided_selection 选定 — 已断言只改 `selectionStatus` + `styleTag`，`status` 保持 pending，**账本条目数仍为 0**；候选外的 tag 被拒；响应明确告知「选定 ≠ 完成」
- [x] 8.5 解锁判定 — 每次实时查库统计 core 任务（`Stage.completionPct` 只用于 UI 进度条，绝不作为解锁依据——缓存一旦不同步会出现「没做完却解锁」且极难排查）；已断言 optional 全跳过也不影响解锁
- [x] 8.6 目标图输入 `buildTargetImageInput` — 基准照片恒为最初正面照（禁用上阶段生成图防身份漂移）+ 已完成账本 + **本阶段未完成 core 的计划变化**；只取 core（core 集合同时定义解锁条件与图内容）；用 per-user 固定 seed；指令用编号列表格式（实测优于逗号串联）
- [x] 8.7 身份保留 + 质量检查 — 保留约束**写进生成指令**（`IDENTITY_PRESERVATION_SUFFIX` 覆盖脸型/骨骼/五官/性别/年龄/种族/身材），而不是事后检查：实测给 img2img 加体型描述词会让模型连脸一起重生成，既然模型对提示词敏感就用提示词钉住边界。质量检查只拦**结构性问题**（尺寸过小、PNG/JPEG 魔数不对——供应商偶尔 HTTP 200 返回错误页），**不做视觉一致性判断**，因为实测通用视觉模型细粒度判断不可靠（脸型一致率 2/10），拿它当「还是不是同一个人」的裁判会误杀好图白烧 ¥0.2。失败重试一次后放弃
- [x] 8.8 失败不阻塞 — 生成失败明确返回 `stageStillUnlocked: true`，落一条 `qualityCheckStatus=failed` 的 TargetImage 但 `consumedWeeklyQuota=false`（决策 15：失败不消耗额度）。阶段解锁在状态更新时已完成，与目标图生成解耦
- [x] 8.9 目标图响应带 `disclosure: "本图基于你勾选的完成情况生成，为模拟效果"`（决策 13 的责任边界兜底）

## 9. 方案修订（spec: plan-revision）
- [x] 9.1 换风格 — 已完成账本全部保留（事实不可撤销，已断言保留 1 条）；新候选集受已完成变化的向量兼容性约束（复用 `checkCompatibility`，零新增概念，被挡时说明哪个维度差多少）；`plan_version` 递增而非重置；**只替换 hair/outfit 域任务**，非风格任务（护肤/健身）不受波及
- [x] 9.2 空集 → 时间预期 — 头发长度这类**物理不可逆**约束优先于向量判断（向量兼容也没用，头发就是不够长）；按 1cm/月估算等待周数，并优先推荐最快可用的方向。实测输出：「中等长度碎盖」约 26 周后可考虑
- [x] 9.3 风格任务拒绝单独替换 — 返回 `must_change_style` 并说明理由（发型和穿搭是同一套风格的两半，单独换会破坏决策 2/3 保证的协调性）
- [x] 9.4 非风格任务替换 — 从 `CandidateTaskCatalog` 同领域取未使用过的等价条目，旧任务标 `replaced`
- [x] 9.5 对话入口 — **复用固定管道的同一套 service，不另写逻辑**（行为不会分叉）；只存结构化决策不存原文（已断言语境里无 messages/transcript 字段）；已否决方向从后续候选中消失；两层审核在对话入口同样生效（红线不可绕过）；解释来自**已算好的确定性结果**而非重新推理（避免对话说法与方案不一致）；生成类动作路由到既有 `user_regeneration` 端点受同一限流约束。**刻意不引入 Mastra Agent 的自主 tool-calling**——动作集有限且已知（改风格/否决/调权重/问解释），确定性意图分类零成本零延迟，让 LLM 自主决定调什么只增加不可预测性而收益为零；LLM 只用在真正需要语言能力处（审核自由输入、写解释文案）
- [x] 9.6 容量限流 — 已在 7.7 实现并断言（按所有生成类操作合并计数，非每端点各算一份）

## 10. 隐私与合规
- [x] 10.1 分级删除端点 — 7 个 scope（单张原图/全部原图/单张目标图/全部生成图/**派生特征**/档案/账号）；返回 **202 Accepted** 而非 200，文案如实说「已受理」不说「已删除」并告知影响条数；另加撤回同意端点——撤回人脸处理同意时**连带受理照片删除**（不能只撤同意却留着数据）
- [x] 10.2 异步清理 — **先删对象存储再删数据库记录**（反过来一旦对象存储失败就永久丢失 storageKey，文件成孤儿）；照片删除级联带走以它为 baseline 的目标图；日志脱敏保留调用记录本身供成本统计。**实施中修掉自己写的一个严重 bug**：脱敏原先没按用户过滤，删一个账号会脱敏所有用户的日志——ProviderCallLog 无 userId 字段，改为经 `TargetImage.providerCallId` 反查，且必须在删除前收集（account 分支会级联删掉 TargetImage）
- [x] 10.3 AI 标识 — 显式：API 响应带 `disclosure`（「AI生成模拟效果 · 基于你勾选的完成情况生成」）；隐式：手写 PNG tEXt chunk 写入 `AI-Generated`/`AI-Provider`/`AI-Generated-At`，9/9 断言含读回验证与结构完整性。刻意不引入 sharp/jimp——那会重编码图片（改像素、增体积），只为插一个 chunk 不值得。不依赖供应商的 `logo_info` 参数，因为换供应商时标识就丢了而这是法定义务
- [x] 10.4 访问日志 — 记录点选在**预签名 URL 签发**而非 HTTP 读取：客户端拿到 URL 后直连 OSS，请求不经过我们，但签发是必经之路。三类 accessor（user/staff_review/system_provider）分别可查，后台人工审核单独可查（合规最关心）；记 `expiresInSeconds` 体现暴露窗口——一次签发在有效期内可反复读取，所以日志是「授权事件」而非「读取次数」

## 11. 集成验证
- [x] 11.1 端到端 API 测试 — 18 个流程节点、40 项断言全通过。覆盖：会话→问卷→同意→照片+FaceMetrics→脸型确认→意向两层审核→initial_analysis(含在途复用)→渐进式部分结果→选发型(两步依赖)→S5落地→阶段0完成解锁阶段1→guided_selection两条状态轴→目标图输入口径→账本用选中候选描述→progress_recheck校准→换风格(向量约束)→对话入口一致性→删除账号级联。不打真实图片 API（那部分在 11.2-11.5 单独验）
- [x] 11.2 验证 `image-generation` 队列在多 worker 下并发确实为 1（对着真实供应商跑）— **这一项发现了一个真实 bug 并已修复**。

  首轮（`test-queue-real-supplier.ts`，2 个 Worker + 6 个真实图生图任务，仅靠队列配置）：**失败**，最大在飞 = 2，**4 个任务被 `code 50430` 拒绝**。根因是我把速率限制当成了并发限制——`concurrency: 1` 只是**每 Worker 实例**上限（2 实例 = 2 在飞），`limiter {max:1, duration:1200}` 只是**启动速率**（任务跑 19s，1.2s 后就放行下一个）。两者都不等于「全局在飞 ≤ 1」。

  ⚠ 这个 bug 差点被漏掉：早前 `test-queue-concurrency.ts` 用 300ms 假 processor 是**通过**的，因为 300ms < 1200ms 限流间隔、任务从不重叠。**快速替身掩盖了真实时序问题**——涉及供应商并发约束的验证必须打真实调用。

  修复：新增 `lib/redisSemaphore.ts`（Redis `SET NX PX` 分布式信号量），`withVolcTaskSlot()` 持槽覆盖**整个 `submit→poll` 生命周期**（供应商并发计数看的是服务端在跑几个任务，不是几个 HTTP 请求在途），槽位按 req_key 分组（承接 12.4 的池粒度结论）。已接入 `volcengineImageEdit` 与 `volcengineClothingSwap` 两条生成路径。刻意不采用「只部署一个 worker」的运维约定：副本数配错或蓝绿发布期间新旧并存就会静默 429，而失败的是用户正在等的效果图。

  复测（同测试、同 2 个 Worker、4 个真实任务）：✅ **零次 50430**，✅ **供应商侧最大在飞 = 1**，✅ 总耗时 53s 符合串行预期，✅ 任务在两个 Worker 间分发。其中 1 个任务因 `code 50220 Download Url Error`（公共图床 picsum 瞬时拉取失败）未出图，与被测机制无关——已在测试里把这类失败与并发失败**分开计数**，否则图床抽风会伪装成并发 bug。

  另加 `test-redis-semaphore.ts` 覆盖真实调用验不了的边界，9 项全通过：单槽互斥、多槽扩容路径、正常/抛异常均释放、TTL 过期自动接管（崩溃持有者不死锁）、**超时持有者不误删接班人槽位（token 校验）**、抢不到时按超时报错不无限挂起。

  实际支出 ¥1.0（首轮 2 次 + 复测 3 次）
- [x] 11.3 渐进式推送 — 用**注入替身 provider** 验证（这验的是我们自己的逻辑，不是供应商行为）：文字推荐先到且图片写入时不被覆盖（增量合并非替换）；提交顺序=匹配度降序，串行提交；逐张写回 `partialResult` 且 pending 归零。真实对象存储写入+清理各 6 个
- [x] 11.4 部分失败降级 — 替身强制第 2 张失败：返回 `completed_partial`（不是 completed 也不是 failed），成功的 2 张仍可用，缺失项在 `missing` 里明确列出（静默少给会让用户以为只有 2 个方案），失败那张被跳过而其余顺序不乱；全部失败才返回 failed。**真实供应商无法命令它失败第 2 张，这条只能用替身验**
- [x] 11.5 目标图失败不阻塞 — 首次+重试均失败后：`stageStillUnlocked:true`、阶段仍为 active、任务清单照常可见、`consumedWeeklyQuota=false`、WorkflowRun 记录 retry=1 与 cost。另验质量检查路径：第 1 次返回过小图触发重试，第 2 次成功，`retryCount=1` 且两个快照均落库
- [x] 11.6 发际线/发量四组合过滤 — 已在 `test-hair-constraints.ts` 以 8 项矩阵断言完整覆盖（含最关键的「仅 volume=thin 不施加约束」防短发误判），并在端到端流程中经 S3 过滤链路复验
- [x] 11.7 换风格候选收窄与空集文案 — 已在 `test-plan-revision.ts` 验证（向量不兼容被挡并说明维度差值；空集给出「约 26 周后可考虑」的时间预期而非一句「不行」），端到端流程中复验候选收窄
- [x] 11.8 `openspec validate add-mvp1-backend-flow --strict` — 通过

## 12. 待验证的可选增强（不阻塞主流程）
- [x] 12.1 阶跃星辰 Step-Image-Edit-2 **代码接入完成，待凭证验证** — `stepfunImageEdit.ts` 已实现并注册进 `ACTIVE_IMAGE_EDIT_PROVIDER=stepfun`，配置位补进 `env.ts` 与 `.env.example`。3/3 装配断言通过：默认仍是 volcengine（新增选项不改变默认行为）、缺 key 时**构造即抛错并指明缺哪个变量**（不静默降级成永远失败的 provider）、未知 provider 名报错列出全部可选项。
  与 Volcengine 实现的三处形态差异（API 本身不同，非风格问题）：①**同步返回**无 submit→poll，故无 task_id，`callId` 用响应 id 兜底 ②**multipart 上传图片本体**而非传 URL 让供应商抓取——少一层预签名 URL 的暴露面 ③返回 base64 而非 URL。
  → 只差 `STEPFUN_API_KEY`（注册 platform.stepfun.com）。拿到后一次真实调用即可完成效果与并发验证
- [~] 12.2 即梦「图生图3.0智能参考」身份保留全身生成 — **找到线索但未验证，刻意不写进代码**。
  官方文档站是 JS 渲染，WebFetch 取不到正文（本 session 多次遇到）。从第三方转售平台文档查到模型标识 **`jimeng_i2i_v30`**，参数含 `image_urls` / `prompt` / `scale` / `width` / `height`；产品侧宣称「多图参考可保持人物特征与深度细节一致性」。
  **不当作已验证**：来源是第三方转售平台而非火山官方，而我们在 req_key 上已盲猜过 7 次全错（`byteoutfit_v1.0`/`outfit_swap_v1`/`high_aes_outfit_swap`…），教训还热着。
  → **需你在火山控制台的 API Explorer 里确认真实 req_key**（那里能看到每个能力的确切取值），或开通该能力后我用一次真实调用验证。验证通过则解除「无全身照不给本人穿搭效果图」的限制，**流程骨架不动**（决策 11 早已按此设计，只是把分支处理从「不给」换成「生成」）
- [~] 12.3 火山引擎并发/QPS 扩充定价 — **调研结论：不公开定价，必须走工单/商务渠道**。公开渠道只查到图生图单价 ~¥0.22/张（我们此前按 ¥0.2 估算，量级一致）；QPS/并发扩充的价格与上限均未公开披露。火山方舟侧的同类能力文档明确写「需联系客服协调资源白名单后才能在线购买」，视觉智能侧同理。
  → **需你在控制台提工单或联系商务询价**，agent 无法完成。询价时要问清三点：①单 QPS 日/月单价 ②可扩到的上限 ③是否按 req_key 分别计费（若共享则 12.4 的答案也一并有了）
- [x] 12.4 验证不同 `req_key`（文生图 vs 图生图）是否共享同一并发池 — **答案：独立池**。`test-reqkey-concurrency-pool.ts` 绕过进程内限流后同时提交 `high_aes_general_v21_L` 与 `seededit_v3.0`，两者都拿到 task_id（1.2s / 10.8s，重叠约 9.6s），无 `50430`。含义要说清楚：**这不能提高同类工作的吞吐**——图生图池仍是 1，决策 12 的吞吐表不变；能拿到的收益只是「文生图类示意图」与「图生图类本人效果图」互不排队。已据此把信号量槽位按 req_key 分组（`volc:<reqKey>`）。实际支出 ¥0.4（2 次）

## 13. 本地 HTTP 冒烟测试暴露的缺口（2026-07-26 发现）

第 1-12 节曾一度全部标为完成，但那是**假象**：所有验证脚本都直接调用 step 函数与 service，
从未走 HTTP → 队列 → worker 这条真实路径。本地起服务实测后，异步链路根本跑不通。
以下三项在原任务清单里**从未存在**——不是标错，是清单本身漏了「把零件装成整机」这一层。

- [x] 13.1 `faceMetrics` 契约校验 — 原先 `photoRegistrationSchema` 用 `faceMetrics: z.unknown()`，什么形状都收。实测提交扁平 `{faceShape:"round"}` 得到 **200**，但读取侧（`getComputedFaceShape` 与 `analyzeVision` 都读 `classification.faceShape.value`）拿不到值，`GET /face-shape/computed` 报「尚无可用的正面照测量数据」。**写入成功 + 读取为空**是最难查的一类错，而这正好是客户端↔服务端契约边界（两端由不同 agent 在写）。已加 `faceMetricsSchema`：结构必需、字段可选（人脸检测可能部分失败）、取值枚举约束（拼写错误立刻 422 而非静默退化成默认值）。实测三种情况均符合预期
- [x] 13.2 预签名 URL 强制 TLS — `ali-oss` 默认签发 **`http://`** 预签名 URL（实测 `upload-url` 返回的就是 http）。签名、AccessKeyId 与**用户人脸照片本体**全程明文，而这类 URL 会经手客户端、日志乃至 AI 供应商。已设 `secure: true`，复验协议为 https 且真实 PUT 仍 200
- [x] 13.3 **job 编排器** — 新增 `src/app/jobOrchestrator.ts`，`worker.ts` 的 processor 降为薄适配层（只解析 payload 转交编排器，业务逻辑一律不放进队列，否则编排逻辑就没法脱离 Redis 单独测）。六种 jobType 全部接通：`initial_analysis`(S1→S2→建方案→S3→S4，逐步写回 partialResult) / `outfit_preview_generation`(S4′) / `plan_materialization`(S5，从 CandidateTaskCatalog 组装规格) / `stage_unlock_generation` 与 `user_regeneration`(targetImageService) / `progress_recheck`(planRevisionService)。
  两处刻意设计：①状态跃迁被拒**只记录不中断**——图片可能已生成并计费，此时崩掉等于白烧钱还不留结果；②异常收敛成 job 的 failed **不重新抛出**——抛出会让 BullMQ 反复重跑整条含真实计费的管道，一个代码 bug 就变成重复扣费
- [x] 13.4 **方案创建** — 落在 `initial_analysis` 编排的 `ensurePlan()` 里，而不是 HTTP 路由：`generationSeed` 必须建方案时一次定死并全阶段复用（决策 4），而 seed 只在确定要开始生成时才有意义。同时创建四条 `Stage`——**只建方案不建阶段，S5 会以「方案应有 4 个阶段，实际 0 个」失败**（实测踩过）
- [x] 13.5 意向文本持久化 — `AppearanceProfile` 加 `stylePreferenceText`/`stylePreferenceStyleTag`/`stylePreferenceUserSpecified` 三字段（migration `add_style_preference_persistence`），`hair-intent` 过审后落库，S3 从库里读。用 `update` 而非 `upsert`：走到这步必然已过问卷，profile 不存在说明流程被绕过，那更该报错而不是悄悄补建一条半空 profile
- [x] 13.6 **`track` 从未持久化** — `saveBasicQuestionnaire` 接收 `track` 却只写 User 的生日与年龄确认，赛道被丢掉；而 `AppearancePlan.track` 是必填，编排器无从得知。已加 `AppearanceProfile.track`（migration `add_track_to_profile`）。`ensurePlan` 缺 track 时**报错而不默认 short_term**——赛道决定阶段窗口与推荐口径，猜错等于给用户一份错方案
- [x] 13.7 **选定发型/穿搭的端点缺失** — `selectedHairstyleId` 只被 `planRevisionService`（换风格，9.x）写过，onboarding 的首次选定没有任何入口，导致 `/outfit-previews` 与 `/materialize` 的「未选发型」校验恒为真、两个端点永久 422。新增 `POST /plans/:planId/select-style`。**只接受出现在推荐候选里的 entryId**：确定性过滤（脸型 + 发际线/发量组合规则）存在的意义就是把不合适的挡在外面，允许客户端提交任意 id 就等于绕过过滤引擎，用户可能选到我们明确判断会暴露发际线问题的发型
- [x] 13.8 **领域词表无权威定义** — `domainSelections` 是 `z.array(z.string())`，`CandidateTaskCatalog.domain` 是自由字符串，两边没有共同词表。实测提交看起来完全合理的 `["hairstyle","outfit","grooming"]` 与目录里的 `face_grooming/skincare/...` **零重叠**，S5 过滤后 0 个任务却报 `completed`——**空方案伪装成成功**，客户端会渲染一份空清单。已建 `data/domains.ts` 权威词表，并按数据来源分成 `CATALOG_DOMAINS`（方法目录驱动）与 `STYLE_DOMAINS`（StyleProfileEntry 驱动，走 S3/S4 不进目录）——不分开的话发型/穿搭永远匹配不到目录，又会得到「选了发型却没有发型任务」。schema 改用枚举校验；编排器在零任务时改报 `completed_partial` 并写明原因
- [x] 13.9 **打分维度缺失导致分阶段机制静默失效** — 编排器起初没给 `MaterializeTaskSpec.dimensions`，而缺省时任务**直接判 optional**。后果比"少个字段"严重得多：四阶段 `coreCount` 全为 0，而 `unlockRule` 是「完成所有 core 才解锁」，core=0 时该条件**空真**，四个阶段立刻全部解锁，分阶段推进整体塌掉——且 UI 上完全看不出来。新增 `data/taskDimensions.ts` 从目录已有字段确定性推导七维度（visualBenefit←visualBenefitLevel、credibility←evidenceBasis、acceptance←用户问卷的 domainAcceptance、reversibility/risk←同名字段、timeCost/moneyCost←解析 estTime/estCostRange）。**只推导不编造**；各档位数值标注为初始校准待产品校准。21 项测试通过，重点覆盖单位陷阱（「2-4 周」若被当成 4 分钟，一个月的任务会被判成低成本落到阶段 0 让用户当天做）。实测结果：core 数 2/3/2/0，阶段 0 active 其余 locked
- [x] 13.10 **S5 非幂等** — `materializePlanStep` 只 create 从不清理。这比"重跑重复"严重：它被 `runWithSingleRetry` 包着，**一次中途失败后的重试就把任务插两遍**。实测重跑后阶段 0 从 4 个变 8 个，同一方法同时以 core 和 optional 各出现一次，用户看到自相矛盾的清单。修法是只删 `pending`、保留 `done`/`skipped`/`replaced`（它们承载用户已做过的事，删掉等于抹掉进度还会断开 `ChangeManifestEntry.sourceTaskId` 追溯链），重建时按 (stageId, domain, title) 跳过已保留项；保留的 core 计入名额以维持「每阶段最多 maxCore 个 core」。11 项测试通过，含「已完成任务重跑后仍为 done」与「追溯链未断」
- [x] 13.11 HTTP 全链路冒烟测试 — `scripts/smoke-http-flow.sh`，**只用 curl 打真实端点**，走 HTTP→队列→worker→编排器→step 全程。与 `test-e2e-flow.ts` 的分工是刻意的：那个直接调 step 函数，因此**测不出编排层缺失**（它曾经全绿而 HTTP 链路是断的）。覆盖 8 节 29 项断言：会话/问卷/同意/预签名直传/faceMetrics 校验/脸型确认/意向两层审核（含真实 LLM）/异步分析全程/两步约束选择（含"非候选不可绕过"）/穿搭降级/S5 落地。⚠ 会产生真实图片费用（3 张约 ¥0.6）
