## Context

绿地项目（无既有代码）。产品定位：AI 形象改善建议，现状→阶段目标→现在该做什么。完整目标架构是 Expo 原生App + 支付订阅 + 短信登录；本轮 MVP1 收窄到 Web+Server，验证核心 AI 分析与方案生成流程。详细背景见 `docs/mvp-plan.md`、`docs/technical-architecture.md`、`docs/product-ui-plan.md`。

## Goals / Non-Goals

- Goals：
  - 跑通问卷+照片 → AI分析 → 分阶段方案 → 任务打卡 → 阶段解锁 → 目标图更新的完整闭环
  - 服务端架构、数据模型按完整目标架构直接实现，不为 MVP 打折扣（后续加App/支付时API基本不用改）
  - 客户端本地人脸测量能力验证（MediaPipe 是否满足精度需求）
- Non-Goals（本轮明确不做）：
  - 短信登录、JWT鉴权、多设备会话管理
  - 支付、订阅、每周生成额度限制
  - 原生 App（Expo）客户端
  - 多渠道支付 Provider（Apple IAP/华为IAP/微信/支付宝）

## Decisions

### 1. 进程拓扑：Fastify API 与 Mastra Worker 分离
- Fastify 进程只处理 HTTP 请求和轻量查询，收到需要 AI 处理的请求后写入 BullMQ 队列即返回
- 独立 Worker 进程（同一代码库，不同启动入口）消费队列并执行 Mastra workflow
- 理由：图像生成等长耗时 AI 调用（可能数分钟）不应占用 API 进程的事件循环资源，两者可独立扩容

### 2. Agent 参与边界
纯业务逻辑（不经过 Mastra/Agent）：问卷提交与存储、照片上传登记、内容安全API调用（确定性规则/第三方API）、阶段优先级打分（固定加权公式）、阶段解锁判定（阈值判断）、任务状态更新、数据删除级联清理。

需要 Agent 参与：视觉结构化分析、场景理解与各领域方案文案生成、目标图生成、排序结果的解释文案生成、LLM语境安全审查。

### 3. AnalysisJob 与 WorkflowRun 的关系
`AnalysisJob` 是业务层的任务追踪实体（面向 `GET /analysis-jobs/:id` 轮询），与 `AppearancePlan`（业务结果）分离。一个 `AnalysisJob` 内部可触发 1-2 个 `WorkflowRun`（Mastra运行的可观测性记录，含成本/延迟/版本）。四种 `job_type`：

| job_type | 触发时机 | 产出 |
|---|---|---|
| `full_analysis` | 用户提交完问卷+照片后点击"开始分析" | 四阶段时间窗口+候选任务池（规则引擎已排序）+ 文字诊断；不生成图像 |
| `stage_unlock_generation` | 用户进入新阶段（含首次进入阶段0） | 该阶段的具体 `StageTask` 清单 + 该阶段目标图（首次，MVP1不限额度） |
| `user_regeneration` | 用户在方案页主动要求重新生成目标图 | 新的 `TargetImage`（MVP1不限额度，完整架构中消耗每周额度） |
| `progress_recheck` | 用户上传真实进度照片 | 方案校准 + 目标图更新 + 真实前后对比 |

### 4. 方案生成分层策略（避免一次性生成全部内容浪费成本）
`full_analysis` 只规划四个阶段的时间窗口和候选任务池骨架，不生成阶段1-3的具体 `StageTask` 明细；具体任务清单在用户实际进入该阶段时由 `stage_unlock_generation` 生成，可参考该阶段实际完成情况/进度照片调整。与目标图的懒生成逻辑一致。

### 5. 目标图生成输入：原始基准照片 + 累计变化清单
`TargetImage.baseline_photo_id` 恒定指向用户最初上传的基准照片，禁止用上一阶段生成图作为下一阶段生成的输入（避免链式img2img导致身份漂移）。`ChangeManifestEntry` 由用户完成 `StageTask` 时自动写入（任务生成时预置 `change_description` 模板，完成时原样写入，不调用LLM）。每次生成使用「基准图 + 当前及之前所有 ChangeManifestEntry + 风格目标 + 身份/体型约束」。

### 6. 优先级规则引擎：LLM打分 + 固定加权公式
`TextPlanningProvider` 为每个候选任务输出各维度原始评分（视觉收益/可信度/接受度/可逆性/时间/费用/风险/时间窗口，0-10结构化数值）。后端按固定加权公式计算综合分并排序：`score = w1*visual_benefit + w2*credibility + w3*acceptance + w4*reversibility - w5*time_cost - w6*money_cost - w7*risk`，权重存于服务端配置（可调，不写死代码）。大模型只负责排序结果的解释文案，不决定排序本身。

### 7. 任务证据依据门槛：evidence_basis 先于打分过滤
`StageTask.evidence_basis` 分三档：`visual_detected`（云端 VisionAnalysisProvider 从照片识别到的问题/特征）、`self_reported`（用户问卷自述，如"有脱发困扰"）、`general_best_practice`（既不能从照片也不能从问卷验证，只是通用建议，如气味管理、社交行为、防晒这类预防性建议，以及受限于当前拍照类型无法可靠识别的项目如牙齿/手部细节）。这是**打分之前的硬性过滤条件，不参与规则引擎的加权评分**：只有 `visual_detected` 或 `self_reported` 的候选任务才允许被规则引擎评为 `priority=core`；`general_best_practice` 的任务无论打分多高都强制为 `priority=optional`，且文案生成时需要用"建议这样做会更好"的通用推荐语气，不能包装成"我们从你的照片/回答里发现了XX问题"的个性化诊断结论（避免向用户过度声称我们实际不具备的检测能力）。

### 8. 身份识别：匿名 device_session_id（MVP1简化）
首次访问签发匿名 `device_session_id`，写入长期 Cookie + 前端 localStorage 双写。`User.phone` 在 MVP1 阶段允许为空。不接短信服务商，不做鉴权（无JWT，无Token刷新），Fastify 路由用 session_id 中间件关联请求到用户。

### 9. 内容锁定：MVP1 全部内容对所有用户开放
完整架构中的付费墙字段级锁定逻辑（`GET /plans/:id` 未订阅时返回 `null`+`locked:true`）在 MVP1 阶段不启用，所有字段直接返回真实内容。`Subscription`/`Order` 相关表结构可以先不建（本轮不需要），或建表但不写入业务逻辑——采用**不建表**，因为 MVP1 完全不涉及支付概念，避免维护无用的空表；下一轮加支付时再新增。

### 10. 队列隔离
BullMQ 按任务类型分队列，各自独立并发度限制：`moderation`（内容安全API调用，高并发低延迟）、`text-analysis`（视觉分析+方案生成，中等耗时）、`image-generation`（目标图生成，慢+成本高，严格限制并发）。

### 11. 数据删除：异步
删除请求（单张/全部照片、生成图、完整档案、账号）API 立即返回成功并标记 `deletion_status=pending`，实际级联清理（对象存储文件+数据库记录+ChangeManifestEntry引用）由 BullMQ 队列异步执行，支持重试。

### 12. 客户端人脸测量：MediaPipe Tasks Vision JS（浏览器WASM）
与完整架构规划的原生App方案（`react-native-mediapipe`）是同一开源引擎（MediaPipe Face Landmarker，478关键点），只是运行时换成浏览器WASM，模型与坐标格式一致，后续迁移到原生App时 `FaceMetrics` 计算逻辑可直接复用。已知缺口：发际线不是标准人脸关键点，本轮不解决，需要额外头发分割模型或启发式算法（留待后续评估）。

### 13. 打理教程内容：文字+人工维护的参考链接（MVP方案，非AI生成/非自制视频）
调研发现男士发型打理领域没有现成的"MuscleWiki式"结构化GIF/视频教程数据库可以直接对接（最接近的是 BluMaan 的视频+图文博客，但呈现形式和覆盖面都达不到可直接接入的程度）；自制分解图/视频的内容制作投入本轮不做。MVP方案：产品/内容团队人工维护一份静态的 `StyleReferenceGuide` 表（发型标签→参考链接+人工撰写的步骤概述，不直接照搬原文避免版权问题），`TextPlanningProvider` 只负责从预定义的 `style_tag` 候选集合里判别用户目标发型属于哪一类，不由 LLM 自由生成或猜测参考链接（避免 URL 幻觉）。未命中任何已知标签的任务，只展示通用文字指导，不强行匹配一个不准确的参考链接。首批 `style_tag` 覆盖范围以已调研的几类为起点：微碎盖、寸头、飞机头、背头、纹理烫，后续按用户实际分布再扩充。

### 14. 引导式选择任务：task_type + selection_status 两条独立状态轴
`StageTask` 分两种交互类型：`simple`（卡片内直接完成/跳过/换一个）与 `guided_selection`（需要先进入专门页面做决策，如发型）。`guided_selection` 任务额外维护 `selection_status`（三档：`not_applicable`/`pending_selection`/`selected`，`simple` 任务恒为 `not_applicable`），与任务的 `status`（`pending`/`done`/`skipped`/`blocked`/`replaced`）是两条独立状态轴——用户在专门页面选定一个选项（如具体发型）只把 `selection_status` 推进到 `selected`，不改变 `status`，也不触发 `ChangeManifestEntry`；只有用户在真实完成该动作后（如实际去理发店剪完）通过与 `simple` 任务相同的状态更新入口把 `status` 置为 `done`，才会写入 `ChangeManifestEntry`。`candidate_style_tags`（该任务展示给用户的候选标签，2-4个）同样由 `TextPlanningProvider` 从预定义 `style_tag` 集合中挑选，不自由生成。首版只有发型一个 `guided_selection` 实例，是"任务→专门页面"的通用模式，后续可扩展到其他领域（如穿搭单品选择）。

### 15. 候选任务内容来源：结构化种子表 CandidateTaskCatalog，不让LLM自由发明方法
调研得到的"男性形象改造方法目录"（26项，覆盖发型/面部细节/穿搭配饰/体态仪态/健身体型/气味管理/口腔/其他8个领域，含耗时/费用/可逆性/风险/适用阶段/视觉收益等属性）落地为人工维护的结构化种子表 `CandidateTaskCatalog`，与 `StyleReferenceGuide` 同样的模式：人工维护、可审计、可控。`TextPlanningProvider` 的职责收窄为"从这张目录表里，结合用户问卷（预算/接受度/track/领域勾选）和视觉分析结果，筛选出适用的候选条目并为每条给出规则引擎需要的各维度评分"，不允许自由生成目录之外的新改造方法。好处：不会出现调研时标注过"不建议纳入"的方法（如 Mewing、下颌线训练器）被模型重新"发明"出来推荐给用户；每条方法的 `evidence_basis` 分类（visual_detected/self_reported/general_best_practice）也直接挂在目录条目上，作为规则引擎判断 `priority=core` 资格的依据之一。代价：新增改造方法需要人工审核后更新目录表，不能靠模型自动扩展覆盖范围。

## Risks / Trade-offs

- **匿名身份 + 无鉴权**：用户清除浏览器数据会丢失方案历史。MVP1 阶段可接受（验证核心流程，非长期留存产品）；下一轮加短信登录时支持"匿名账号绑定手机号"升级路径，需在 `User` 表设计时预留（`device_session_id` 字段与 `phone` 字段都可空，二选一或共存）。
- **不限生成额度**：目标图生成成本无节流，MVP1 测试阶段需要人工监控云服务商账单，防止异常调用。
- **方案分层生成（懒生成阶段1-3任务）**：意味着"方案Tab"展示阶段时间线时，阶段1-3只能展示"时间窗口+候选任务池方向"，不能展示具体任务标题，产品UI需要相应处理未生成阶段的占位展示（本次变更不涉及UI细节调整，实现时需注意）。
- **`StyleReferenceGuide` 是人工维护的静态数据，不会自动跟着外部内容变化**：外部参考链接可能失效（link rot）或内容被下线，需要有人定期巡检；首版覆盖的发型标签数量有限，命中率不会很高，大部分任务仍然只有通用文字指导，没有参考链接可看。

### 16. Agent + Tool 组装，不做一站式多模态集成
Agent 的"推理大脑"（驱动 `TextPlanningProvider` 的底层模型）与"视觉/图像能力"完全解耦：推理大脑不要求自身具备多模态（看图）能力，视觉分析、img2img、虚拟试衣都建模为 Agent 可调用的独立 Tool（每个 Tool 内部封装对相应 Provider 的调用），Agent 只接收 Tool 返回的结构化结果（如视觉分析 Tool 返回的文字/JSON描述）进行推理，不需要自己"看懂"图片。这意味着：
- 选"推理大脑"用的模型时，纯看推理/指令遵循/结构化输出质量，是否支持多模态不是筛选条件；
- `VisionAnalysisProvider`/`ImageEditProvider`/`VirtualTryOnProvider` 三者各自独立选型，互相之间、以及和推理大脑之间，都不要求是同一家供应商或同一个模型；
- 具体每个 Provider 由哪家供应商实现是运营期可调整的配置（见 Open Questions），本决策只固定"组装方式"，不固定"组装用的具体供应商"。

## Migration Plan

绿地项目，无迁移。Prisma migration 从空库开始建表。

## Open Questions

- **模型供应商：候选已收窄，但最终选型需要实测效果，不是按价格直接定案**。选型原则：满足需求优先于价格，价格可以通过订阅定价分摊给用户，不是约束实现方案的首要因素。
  - `TextPlanningProvider`：阿里云百炼通义千问 或 智谱GLM，两者能力都够用，暂不是评估重点
  - `VisionAnalysisProvider`：阿里云百炼通义千问VL 或 智谱GLM-4V(-Flash)，需要对比两家对面部特征/体态/穿搭现状的结构化描述准确度
  - `ImageEditProvider`（img2img）候选：阿里云百炼通义万相图像编辑（`wanx2.1-imageedit`/`wan2.5-image-edit`） vs 字节即梦AI 图生图。**没有查到任何第三方对这两家"人脸身份一致性保持"质量的独立评测**，而这直接关系到产品"不能整容级改变五官/脸型/骨架"的硬性约束（见完整架构 8.2 目标图约束），是评估的核心指标，不能只看价格或文档描述
  - `VirtualTryOnProvider`（虚拟试衣）候选：阿里云百炼 AI试衣（`aitryon`/`aitryon-plus`+`aitryon-refiner`），国内该细分能力目前文档最完整的方案，但同样没有第三方效果评测，且具体单价未公开（需开户后在控制台核实）
  - **实测评估计划**（开户后、正式实现 `ImageEditProvider`/`VirtualTryOnProvider` 之前执行）：用同一批真实测试照片（覆盖不同脸型/体型/发量），对候选供应商跑相同的"基准图+变化清单"输入，逐一检查：①身份一致性（五官/脸型是否被意外改变）②体型比例保持（身高/肩宽/骨架是否走样）③指令遵循度（要求的具体变化是否真的体现在输出图里）④图像质量与是否出现明显AI瑕疵（手指/衣物褶皱等）⑤虚拟试衣场景下服装贴合度和光影自然度。按这5项打分对比，而不是先看价格再将就选一个。
  - Provider 抽象层设计已支持后续替换，不会因为先用某家测试而绑死架构。
- 优先级公式的具体权重数值（w1-w7）需要产品侧配合业务经验给出初始值，或先用等权重上线后再调优。
