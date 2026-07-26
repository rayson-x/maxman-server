# BetterMeet 技术架构文档 v0.4

> 范围：完整目标架构的设计、数据模型、接口与工作流设计，不含具体代码实现。客户端 Expo（React Native），服务端 Node.js（Fastify + TypeScript），Agent 编排使用 Mastra。
>
> 本文档描述的是产品最终形态的完整架构。MVP1（Web+Server）阶段的范围界定、简化点见独立的 `../../docs/mvp-plan.md`，两份文档配合阅读：`../../docs/mvp-plan.md` 说明"这一轮做哪些、怎么和这份完整架构对应"，本文档是目标全貌。
>
> v0.4 变更：后端业务流程深挖——新增 AnalysisJob 实体（与 WorkflowRun 一对多关联）、方案生成分层策略（阶段结构预规划+每阶段任务懒生成）、StageTask 改为不按日期分配的阶段级清单、优先级规则引擎的固定加权公式机制、ChangeManifestEntry 由任务完成自动生成（不经LLM）、JWT鉴权机制、内容锁定的服务端字段级策略、异步删除机制、按任务类型分队列的隔离策略。
>
> v0.3 变更：新增客户端本地人脸关键点测量能力（见 2.3 节），本地计算的面部比例数据作为云端视觉分析的辅助输入，不替代云端分析。

---

## 一、总体架构

```
┌──────────────────────────┐
│   Expo App (iOS/Android)  │
│  Expo Prebuild + Dev Build │
└─────────────┬─────────────┘
              │ HTTPS REST
┌─────────────▼─────────────┐
│   Fastify API Server       │        ┌───────────────────────┐
│  (TypeScript, 国内云部署)    │◄──────►│ Redis (队列/幂等/限流)   │
└──┬────────┬────────┬───────┘        └───────────────────────┘
   │        │        │
   │        │        └────────────► ┌─────────────────────┐
   │        │                       │ Mastra Workflow 引擎  │
   │        │                       │ (AI 编排，非业务状态源) │
   │        │                       └──────────┬──────────┘
   │        │                                  │
   │        │                       ┌──────────▼──────────┐
   │        │                       │ Model Provider 抽象层 │
   │        │                       │ Vision/Text/Image/    │
   │        │                       │ Moderation/Embedding  │
   │        │                       └──────────┬──────────┘
   │        │                                  │
   │        │                   国内模型（首选）/ 海外模型（可切换）
   │        │
   │        └──────────► PostgreSQL (Prisma)：用户/方案/任务/订单/
   │                       订阅/授权记录/模型调用日志（唯一业务状态源）
   │
   └──────────► 对象存储 阿里云OSS/腾讯云COS（私有Bucket + 短签URL）
                   ├── 原始照片 Bucket/前缀
                   ├── 生成目标图 Bucket/前缀
                   └── 派生特征数据 Bucket/前缀（隔离存储）

┌───────────────────────────────────────────────────┐
│ 支付层：AppleStoreKitProvider / HuaweiIAPProvider /   │
│ WeChatPayProvider / AlipayProvider / OtherChannel    │
└───────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────┐
│ 内容安全层：图片内容安全API + 文本内容安全API（独立于     │
│ LLM 安全审查 Prompt，作为确定性规则最终把关）             │
└───────────────────────────────────────────────────┘
```

**关键原则**：
- Mastra 只负责 AI 编排与推理，**不持有业务状态**；每次 workflow 运行的结果、版本、成本都同步落到 PostgreSQL。
- 所有外部模型（图像生成、文本推理、内容安全）都通过按能力拆分的 Provider 接口调用，业务层永远拿到的是**统一 Schema**，不直接暴露供应商原始返回。
- 阶段优先级排序**不完全交给大模型自由判断**：后端规则打分决定顺序，大模型负责解释文案。

---

## 二、客户端（Expo）架构

### 2.1 构建方式

- 使用 **Expo Prebuild（CNG, Continuous Native Generation）+ Development Build**，不使用 Expo Go 作为生产开发方式。
  - 原因：需要接入 Apple IAP、华为 IAP、微信支付、原生相机/相册、推送、安全存储等原生能力，Expo Go 沙盒无法支持这些原生模块。
- iOS 与不同 Android 分发渠道（应用宝/华为/小米/OV/官网包）使用**独立的 Product Flavor / EAS Build Profile**，因为各渠道要求的支付 SDK、审核合规要求不同。
- 原生能力（支付、相机、推送、Keychain/Keystore 安全存储）通过 **Config Plugin** 或自定义原生模块接入，纳入 EAS Build 配置管理，不手动改原生工程。

### 2.2 应用结构

```
app/
├── (onboarding)/          # 引导流程：非 Tab，线性 Stack 导航
│   ├── landing
│   ├── goal-selection        # 短期/长期
│   ├── quick-questionnaire   # 基础低敏问卷
│   ├── login
│   ├── full-questionnaire
│   ├── photo-consent
│   ├── photo-upload
│   ├── analyzing
│   ├── free-preview
│   └── paywall
│
└── (main)/                # 登录后主应用，底部 Tab 导航
    ├── progress/             # 对应产品UI规划的"进度"Tab（原"今天"，已改名）
    ├── plan/
    │   ├── index
    │   ├── haircut-card
    │   ├── outfit-detail
    │   ├── recheck
    │   └── stage-unlock
    └── profile/
```

- 路由：Expo Router（文件路由，天然对应上面的信息架构）。
- 状态管理：服务端为唯一状态源（订阅、任务进度、阶段解锁均由后端裁定），客户端使用 **TanStack Query** 做服务端状态缓存 + 轮询，本地仅用轻量 store（如 Zustand）管理纯 UI 态（表单草稿、当前步骤等）。
- 分析/生成状态轮询：`GET /analysis-jobs/:id`，指数退避（前30秒每2秒 → 之后每5秒 → 2分钟后每10秒）。MVP 不做 SSE/推送，预留后续升级空间。

### 2.3 客户端本地人脸关键点测量（离线，不经云端）

**目的**：在拍照/上传环节实时算出面部几何比例（如颞部宽、颧骨宽、下颌宽、脸长、双眼间距等），一是给用户即时的拍照质量反馈和检测可视化（呼应"分析等待/实时检测"页的设计语言），二是把精确数值和照片一起上传，作为云端 `VisionAnalysisProvider` 的辅助结构化输入，减少模型仅凭图像估算比例产生的误差/幻觉。**该能力不替代云端的风格/审美判断**，只解决"精确测量"这一件事。

- **引擎选型**：Google **MediaPipe Face Landmarker**（Apache-2.0 开源，Google AI Edge 项目），单帧输出 478 个 3D 人脸关键点 + 变换矩阵，iOS/Android 均有官方原生 SDK，全程设备端推理，无需联网。
  - React Native 接入：`react-native-mediapipe`（基于 VisionCamera frame processor 的社区封装），需要 Expo Dev Build（已在 2.1 节确定，不新增约束）。
  - 对比过 Google **ML Kit Face Detection**（同为免费、设备端、官方 Expo 模块封装更省事，但轮廓点位密度不如 MediaPipe，够用但算细分比例时精度打折扣）——首版选 MediaPipe 是为了给出与"焕颜计划"式检测可视化同等精细度的数据。
- **已知能力边界**：478 个关键点覆盖脸部轮廓、五官、虹膜，可以直接算出脸宽/脸长/五官间距等**几何比例**；但**发际线不是标准人脸关键点**，两个方案都不直接支持，若要做发际线检测需要额外的头发分割模型或前额区域颜色对比启发式算法，属于待评估的独立技术点，不在本轮方案内视为已解决。
- **数据流**：
  1. 拍照/上传页调用本地 Face Landmarker 做实时检测 → 叠加关键点可视化 + 质量判断（是否检测到单一人脸、是否居中、光照是否均匀）
  2. 确认照片后，本地计算一组结构化比例数据（`FaceMetrics`：颞部宽、颧骨宽、下颌宽、脸长、双眼间距等，具体字段留待与产品定稿）
  3. 上传照片时，`FaceMetrics` 随请求一起提交给服务端，落库关联到对应 `UserPhoto`
  4. Mastra workflow 的 `VisionAnalysisProvider` 调用（见 7.1 Step 2）同时接收照片与 `FaceMetrics`，用真实数值校正/约束模型的几何描述，模型只负责风格/美学层面的判断

---

## 三、服务端（Fastify + TypeScript）

### 3.1 分层

```
routes/        # REST 路由定义与请求校验（zod/typebox schema）
services/      # 业务逻辑：问卷、方案生成编排、阶段推进、订阅、支付
providers/     # 模型 Provider 与支付 Provider 的具体实现
workflows/     # Mastra workflow 定义（调用 services 而非直接操作 DB）
repositories/  # Prisma 数据访问层
jobs/          # BullMQ 队列 worker（分析任务、图像生成任务、支付回调处理）
```

### 3.2 核心 REST 接口（示意，非最终定稿）

| 接口 | 说明 |
|---|---|
| `POST /auth/device-session` | MVP1：显式签发匿名 `device_session_id`（首次访问时客户端主动调用一次，而非依赖中间件隐式签发），返回长期 Cookie；幂等——已有有效 session 时直接返回现有的 |
| `POST /auth/otp` / `POST /auth/login` | 手机号短信登录，返回 Access Token(短期) + Refresh Token(长期)（完整架构，MVP1不实现） |
| `POST /auth/refresh` | 用 Refresh Token 换取新的 Access Token（完整架构，MVP1不实现） |
| `POST /questionnaire/basic` / `POST /questionnaire/full` | 提交问卷 |
| `POST /photos/consent` | 记录人脸信息处理同意（版本化存证） |
| `POST /photos` | 上传照片（预签名直传对象存储 + 回调登记） |
| `POST /analysis-jobs` | 触发一次分析（问卷+照片就绪后） |
| `GET /analysis-jobs/:id` | 轮询分析/生成任务状态 |
| `GET /plans/:id` | 获取指定方案（现状、阶段、目标图、各子方案，一次性返回全部阶段的任务，不再单独提供按阶段查任务的接口）；未订阅时锁定字段服务端直接返回 `null` + `locked:true`，不下发真实内容，安全边界在API层而非客户端 |
| `GET /plans/current` | `GET /plans/:id` 的别名：根据当前 session 直接查该用户唯一的活跃 `AppearancePlan` 并返回，客户端不需要预先知道 plan id。内部路由到与 `GET /plans/:id` 相同的处理逻辑 |
| `POST /plans/:id/stages/:stageId/tasks/:taskId/status` | 更新任务状态（完成/跳过/替换） |
| `POST /plans/:id/stages/:stageId/tasks/:taskId/select` | guided_selection 任务提交选定的 `style_tag`（从 `candidate_style_tags` 中选一个），`selection_status` → `selected`；不改变 `status`，不触发 ChangeManifestEntry |
| `POST /plans/:id/target-images/regenerate` | 主动请求更新目标图（消耗每周额度） |
| `POST /plans/:id/recheck` | 上传进度照片，触发免费校准+目标图更新 |
| `POST /subscriptions/checkout` | 发起订阅（返回对应支付渠道所需参数） |
| `POST /webhooks/apple` / `/webhooks/wechat` / `/webhooks/alipay` / `/webhooks/huawei` | 支付/订阅回调 |
| `GET /me/entitlements` | 当前订阅状态与本周剩余更新次数（服务端权威来源） |
| `DELETE /me/photos/:id` / `DELETE /me/photos` / `DELETE /me/profile` / `DELETE /me` | 分级数据删除 |

### 3.3 鉴权、幂等与安全

- **鉴权**：JWT Access Token（短期，如15分钟过期）+ Refresh Token（长期，如30天过期）。Access Token 放 `Authorization` header，无状态校验，服务端无需为每次请求查会话表；Refresh Token 存客户端安全存储（Expo SecureStore/Keychain），仅在 `/auth/refresh` 时使用一次性换新（Refresh Token 本身也应支持轮换和吊销，吊销名单存 Redis）。
- 所有会触发计费/生成的接口要求幂等键（`Idempotency-Key` header），防止客户端重试导致重复生成或重复扣费。
- 支付回调（webhook）验签 + 幂等落库，回调可能重复投递。
- 图片直传使用短时预签名 URL，服务端在收到"上传完成"回调后才登记记录并触发内容安全审核。

---

## 四、数据模型（PostgreSQL + Prisma）

### 4.1 核心实体

```
User
  id, phone(hash), birth_date, age_confirmed_18plus, created_at

ConsentRecord
  id, user_id, consent_type[terms|face_processing|training], version,
  granted_at, revoked_at, source_ip, snapshot_text_ref

AppearanceProfile
  id, user_id, height, weight, waist, occupation, wears_glasses,
  has_beard, hair_loss_concern, domain_selections[hair_outfit|skincare|fitness],
  domain_acceptance(json), budget_tier

Event                              # 短期分支才有值，长期分支为空
  id, user_id, event_type, event_date, city, venue_type,
  activity_type, desired_impression, formality_level

UserPhoto
  id, user_id, photo_type[front|side|full_body|progress],
  storage_key, uploaded_at, moderation_status, deletion_status,
  training_consent_id (nullable),
  face_metrics(json, nullable)      # 客户端本地 Face Landmarker 计算的几何比例，见 2.3 节

AnalysisJob                        # 任务进度追踪实体，GET /analysis-jobs/:id 轮询的对象
  id, user_id, plan_id(nullable，首次full_analysis完成前为空), stage_id(nullable，
  仅stage_unlock_generation/progress_recheck等指向具体阶段的类型才有值),
  job_type[full_analysis|stage_unlock_generation|user_regeneration|progress_recheck],
  status[created|uploading|input_moderating|analyzing|planning|generating|
  output_moderating|quality_checking|completed|failed|cancelled],
  error_reason(nullable), created_at, updated_at, completed_at(nullable)

AppearancePlan                     # 每个用户只有一条活跃记录，不产生历史行
  id, user_id, event_id(nullable), track[short_term|long_term],
  current_stage, status, created_at, plan_version  # 原地自增，非新建行；
                                                    # 历史演变靠 WorkflowRun 审计追溯

Stage
  id, plan_id, stage_index[0,1,2,3], window_label,
  status[locked|active|completed], unlock_rule(json),
  completion_pct                    # 仅用于UI进度条展示，不作为解锁判定依据

ChangeManifestEntry                # 累计变化清单，图像生成的关键输入
  id, plan_id, stage_id, source_task_id(nullable，指回产生该条目的StageTask，
  便于追溯/修正错误的change_description), domain, change_description,
  method_summary, created_at

TargetImage
  id, plan_id, stage_id, image_type[face_hair|full_body_outfit],
  baseline_photo_id,               # 始终指向最初的基准照片，而非上一阶段生成图
  manifest_snapshot(json),         # 生成时使用的累计变化清单快照
  storage_key, change_explanation(json),
  quality_check_status, retry_count, is_free_first_generation(bool),
  consumed_weekly_quota(bool), model_version, provider, created_at

StageTask                          # 阶段任务：一个阶段一份扁平清单，不按日期分配
  id, stage_id, domain, priority[core|optional],
  evidence_basis[visual_detected|self_reported|general_best_practice],
                                     # 硬性前置门槛，不参与规则引擎打分：
                                     # 只有 visual_detected/self_reported 才允许 priority=core；
                                     # general_best_practice（气味类、社交行为类、防晒等无法从照片
                                     # 或问卷验证的通用建议）永远只能是 optional，文案上也要用
                                     # "建议这样做更好"而非"我们发现你需要改善XX"的诊断语气
  task_type[simple|guided_selection], # simple：卡片内直接完成/跳过/换一个；
                                     # guided_selection：需要先进入专门页面做选择（如发型），
                                     # "任务→专门页面"通用模式，首版只有发型一个实例，
                                     # 后续可扩展到穿搭单品/护肤流程等领域
  selection_status[not_applicable|pending_selection|selected],
                                     # task_type=simple 时恒为 not_applicable；
                                     # task_type=guided_selection 时从 pending_selection 起步，
                                     # 用户在专门页面选定后转为 selected。
                                     # 与下面的 status 是两条独立状态轴：selected 只代表"决策完成"，
                                     # 不代表真实变化已发生，ChangeManifestEntry 仍然只在 status=done 时写入
  candidate_style_tags(json array, nullable),
                                     # guided_selection 任务展示给用户选择的候选标签集合（如
                                     # ["微碎盖","纹理烫","寸头"]），由 TextPlanningProvider 从
                                     # 预定义标签集合中判别推荐，不自由生成新标签
  title, est_time, est_cost, rationale, completion_criteria,
  alternative, expected_impact, status[pending|done|skipped|blocked|replaced],
  sort_order,                        # 建议顺序，非强制日期
  change_description,               # 任务生成时预写好，完成时原样写入 ChangeManifestEntry，不再调用LLM
  style_tag(nullable)                # guided_selection 任务里，用户从 candidate_style_tags 中确认选定
                                     # 的那一个（命中 StyleReferenceGuide 才会附带参考教程）；
                                     # simple 任务恒为空

StyleReferenceGuide                  # 人工维护的静态种子数据，MVP版"文字+参考图链接"方案的落地
  id, domain, style_tag,             # 如 domain=hair, style_tag="微碎盖"
  title, reference_url, reference_type[article|video|image],
  summary_text,                      # 打理步骤的文字概述，人工撰写/改写（不直接照搬原文，避免版权问题）
  updated_at
  # 没有匹配到任何 style_tag 的任务，StageTask 只展示通用文字指导，不附带参考链接

CandidateTaskCatalog                 # 人工维护的结构化改造方法目录，规则引擎的候选任务来源
  id, domain[hair|face_grooming|outfit_accessory|posture|fitness|body_odor|dental|other],
  method_name, description,
  evidence_basis[visual_detected|self_reported|general_best_practice],
  est_time, est_cost_range, reversibility[full|partial|irreversible],
  risk_level[low|medium|high], risk_note,
  applicable_stage_range(json, 如["stage0","stage1"]),
  visual_benefit_level[low|medium|high],
  is_recommended(bool),               # 调研中标注"不建议纳入"的方法（如Mewing、下颌线训练器）
                                       # is_recommended=false，规则引擎永远不选取，仅作记录保留原因
  exclusion_reason(nullable),         # is_recommended=false 时说明原因
  created_at, updated_at
  # TextPlanningProvider 只从 is_recommended=true 的条目中筛选适用候选并打分，不自由生成目录外的新方法

Subscription
  id, user_id, platform[ios|android_channel], price_variant_id,
  status[trialing|active|canceled|expired], current_period_end,
  weekly_image_quota, weekly_quota_used, quota_reset_at

Order
  id, user_id, subscription_id(nullable), provider[apple|huawei|wechat|alipay],
  amount, currency, status, provider_txn_id, raw_payload_ref

WorkflowRun
  id, job_id,                       # 外键指回 AnalysisJob，一个Job可关联1-2条WorkflowRun
  plan_id, workflow_run_id, plan_version, artifact_version,
  prompt_version, model_version, provider, latency_ms, retry_count,
  cost, safety_result(json), quality_result(json), final_status

Feedback
  id, plan_id, helpful_score, confidence_change, completed_actions(json), comments
```

### 4.2 关键设计说明

- **`TargetImage.baseline_photo_id` 恒定指向用户最初上传的基准照片**：明确禁止用"上一阶段生成图"作为下一阶段生成的唯一输入，避免链式 img2img 造成的身份漂移。每次生成都基于「原始基准图 + 累计变化清单快照 + 风格目标 + 身份/体型约束」。
- **`ChangeManifestEntry` 是累计变化的结构化记录**，来源是纯业务逻辑而非LLM调用：用户把 `StageTask` 标记为完成时，后端直接把该任务预写好的 `change_description` 写入一条 `ChangeManifestEntry`（跳过/未完成的任务不产生条目）。下一次目标图生成时把当前及之前所有条目一起传给图像模型，保证"渐进累加"而不是"从头编造"。
- **`Stage.unlock_rule`** 存结构化规则，MVP1固定为 `{"require_all_core_tasks":true}`：本阶段**全部**核心任务（可能来自不同领域，如发型+穿搭同为核心）都标记为 `done` 才解锁下一阶段，可选任务不影响解锁判定；核心任务数量按后端服务实时查询 `StageTask` 计算（`priority=core` 且 `status!=done` 的计数为0即满足），不做缓存字段，避免状态不同步。由后端服务判定，不依赖前端判断。
- **`TargetImage.is_free_first_generation` / `consumed_weekly_quota`**：区分"进入新阶段的首次生成"（不计入每周额度）与"用户主动重新生成/调整"（计入额度）。生成失败、内容审核失败、系统重试、质量检查未通过均不设置 `consumed_weekly_quota=true`。
- **用户侧完全不出现"积分"字样**，`Subscription.weekly_image_quota / weekly_quota_used` 是内部字段，前端展示为"本周剩余N次目标图更新"。
- **`UserPhoto.face_metrics`** 只存客户端本地计算得到的几何比例数值（非图片、非生物特征模板本身），用于辅助云端视觉分析校正几何描述，不单独作为身份识别用途。

---

## 五、对象存储与图片生命周期

- 阿里云 OSS 或腾讯云 COS，私有 Bucket，按类型隔离前缀/Bucket：`raw/`、`generated/`、`derived-features/`。
- 所有客户端访问通过服务端签发的**短时限时 URL**，不暴露长期公开链接。
- 访问日志：记录谁在何时访问了哪张照片（尤其是后台人工审核场景），满足 PRD 隐私章节的"敏感照片访问需记录操作日志"要求。
- 生命周期：
  1. `uploading` → 客户端直传对象存储
  2. `input_moderating` → 图片内容安全 API 扫描（色情/未成年人/非本人/公众人物等）
  3. 通过后进入分析流程，未通过则标记失败并提示用户
  4. 分析/生成完成后按用户设置的保存策略保留；用户可随时分级删除（单张原图/全部原图/单张目标图/全部生成图/派生特征/完整档案/整个账号）
  5. 删除请求需要级联清理：对象存储文件 + 数据库记录 + 关联的 ChangeManifestEntry 引用 + 模型调用日志中的照片引用（脱敏保留统计用途）
  6. 删除是**异步**操作：API 收到删除请求后立即将 `deletion_status` 标记为 `pending` 并返回成功，实际的对象存储文件删除与跨表级联清理由 BullMQ 队列后台异步执行（支持重试）；"我的-数据管理"页面需明确告知用户"删除已提交，将在N小时内完成"，不承诺同步删除。

---

## 六、异步任务与状态机

### 6.1 队列

- Redis + BullMQ（或云厂商同类消息队列）。
- 支持：重试（带退避）、超时、死信队列、幂等处理、任务取消、Provider 回调驱动的任务完成、单次任务成本记录。
- **按任务类型分队列，各自独立并发度限制**，避免慢任务拖垮快任务：
  - `moderation` 队列：内容安全API调用、支付回调处理，高并发、低延迟
  - `text-analysis` 队列：视觉分析、文本方案生成，中等耗时
  - `image-generation` 队列：目标图生成，慢（可能数分钟）、成本高，严格限制并发数（避免图像模型供应商限流/超预算）
  - 每类队列独立配置 worker 并发数、超时阈值、重试策略

### 6.2 分析/生成任务状态机

```
created → uploading → input_moderating → analyzing → planning
        → generating → output_moderating → quality_checking
        → completed
                 ↘ failed（任何阶段的不可恢复错误）
                 ↘ cancelled（用户主动取消）
```

- `quality_checking` 未通过：自动重试一次生成；第二次仍未通过 → `failed`，并标记不消耗额度。
- 客户端始终通过 `GET /analysis-jobs/:id` 轮询该状态机的当前状态与阶段性文案（对应"分析等待页"的动态提示）。
- **⚠ 待确认**：`uploading`/`input_moderating` 这两个状态是否对全部4种 `job_type` 都适用？`full_analysis`/`stage_unlock_generation`/`user_regeneration` 触发时，照片早已上传并通过审核（`POST /analysis-jobs` 的前置校验要求照片已是 `moderation_status=passed`），这两个状态对它们而言是空转/瞬时跳过；只有 `progress_recheck`（用户提交新的进度照片触发）才会真正经历这两个状态。实现时需要明确：这两个状态是否保留为"全部job统一但部分job瞬间跳过"，还是按 job_type 拆分出不同的状态子集。

---

## 七、AI / Agent 架构（Mastra）

### 7.1 编排方式

单一 Mastra Workflow，按模块拆分为 Step，串行 + 并行结合：

```
Step 1: 输入图片安全审核（调用 ImageModerationProvider）
Step 2: 视觉结构化分析（调用 VisionAnalysisProvider，输入含照片 + 客户端本地计算的 FaceMetrics）→ 输出结构化用户外貌特征
Step 3: 用户形象档案生成（合并问卷 + 视觉分析）
Step 4: 并行分支（Promise.all 语义）：
        ├─ 发型方案 Step（TextPlanningProvider）
        ├─ 穿搭方案 Step（TextPlanningProvider）
        ├─ 护肤修饰方案 Step（TextPlanningProvider）
        └─ 健身饮食方案 Step（TextPlanningProvider）
Step 5: 优先级与阶段编排
        - TextPlanningProvider 为每个候选任务输出各维度**原始评分**（视觉收益/可信度/接受度/可逆性/时间/费用/风险/时间窗口，每项 0-10 的结构化数值，非排序本身）
        - 后端按固定加权公式计算综合分并排序、分配阶段：`score = w1*visual_benefit + w2*credibility + w3*acceptance + w4*reversibility - w5*time_cost - w6*money_cost - w7*risk`，权重存于服务端配置（可远程调整，不写死代码）
        - 大模型仅负责为排序结果生成解释文案，不决定排序本身
Step 6: 先返回文字诊断（此时可让免费预览页先展示）
Step 7: 异步：目标图生成（ImageEditProvider，输入=基准图+变化清单快照+约束）
Step 8: 身份与体型比例质量检查（自动化规则 + 视觉一致性模型）
Step 9: 输出内容安全审核（ImageModerationProvider + LLM 语境安全审查）
Step 10: 发布完整方案，落库 PostgreSQL
```

### 7.2 可观测性

每次 workflow 运行必须持久化到 `WorkflowRun` 表：`workflow_run_id, plan_version, artifact_version, prompt_version, model_version, provider, latency, retry_count, cost, safety_result, quality_result, final_status`，用于成本核算、A/B 效果对比、问题追溯。

### 7.3 Model Provider 抽象（按能力拆分，而非单一 ModelProvider）

```
VisionAnalysisProvider   # 面部/体型结构化分析
TextPlanningProvider     # 场景理解/优先级/计划生成/发型卡文案等文本推理
ImageEditProvider        # 目标图 img2img 生成
VirtualTryOnProvider     # 预留：后续虚拟试衣能力
ImageModerationProvider  # 图片内容安全
TextModerationProvider   # 文本内容安全
EmbeddingProvider        # 预留：如需要相似风格检索
```

- 每个 Provider 接口的**输出必须是业务层定义的 Schema**，不透传供应商原始响应结构。
- 首版默认接入**国内模型**（图像编辑与文本推理均可替换），架构上同时支持接入海外模型（如更强的 img2img 效果模型），通过配置切换或按用户/实验分组灰度。
- 每个 Provider 实现需支持：同步或异步调用、回调、超时、自动重试、成本记录、安全结果回传、模型版本记录。

---

## 八、支付架构

```
PaymentProvider (interface)
  ├── AppleStoreKitProvider    # iOS，StoreKit + 服务端票据校验 + 订阅续期/退款 Webhook
  ├── HuaweiIAPProvider        # 华为渠道分发时使用
  ├── WeChatPayProvider        # Android 部分渠道
  ├── AlipayProvider           # Android 部分渠道
  └── OtherChannelProvider     # 预留其他 Android 分发渠道
```

- **订阅状态与权益完全由服务端维护**（`Subscription` 表 + `GET /me/entitlements`），客户端本地不缓存权威状态，只做展示层缓存。
- 定价**不写死在代码或文档中**，由服务端远程配置下发（支持多组合 A/B：如首周¥1.99/续¥3.99、首周¥3.99/续¥6.99、包月¥19.9等），客户端渲染时读取配置。
- 单独购买额外目标图更新次数（超出每周额度）：iOS 必须走 Apple IAP；Android 按分发渠道选择对应支付方式。
- Apple 侧需实现服务端订阅事件通知（App Store Server Notifications）处理续期、退款、账单问题等状态同步。

---

## 九、内容安全（多层审核）

```
1. 客户端上传前提示（引导规范拍摄，非强制拦截）
2. 输入图片 → ImageModerationProvider（色情/未成年人/非本人/公众人物检测）
3. 问卷与用户输入文本 → TextModerationProvider
4. 模型生成（图像/文本）
5. 输出图片 → ImageModerationProvider 二次审核
6. 输出文本 → LLM 语境安全审查（PRD 第八章的安全审查 Prompt）
7. 视觉质量与身份一致性检查（非安全范畴，但同一 pipeline 位置执行）
8. 确定性规则最终阻断（硬编码红线，不受模型判断影响，如"检测到未成年人特征→无条件阻断"）
```

重点识别对象：裸露色情内容、未成年人照片、非本人照片、公众人物照片、自伤/严重外貌厌恶倾向、极端减重/饮食障碍表达、危险健身行为描述、明显医疗皮肤问题、违法违规内容。命中高风险项的请求**不进入常规生成流程**，转为提示"建议咨询专业人士"的克制文案。

---

## 十、隐私与合规技术实现

- **年龄**：注册时采集出生日期 + 18+ 自声明勾选，服务端据此计算年龄用于风控，不做强制身份核验。
- **人脸敏感信息独立同意**：`ConsentRecord` 表版本化存储同意文本快照、同意时间、撤回时间，三类同意（总协议/人脸处理/模型训练）互相独立、可单独撤回。
- **默认不用于模型训练**：图像生成/分析调用不携带训练标记，除非该用户存在有效的 `training_consent` 记录。
- **数据可分级删除**：单张原图、全部原图、单张目标图、全部生成图、面部派生特征、完整形象档案、整个账号，均对应独立的删除接口和级联清理逻辑。
- **AI 生成内容标识**：页面显式展示"AI生成模拟效果"、导出图片添加可见水印、文件 EXIF/元数据写入 AI 生成标记；分享时不得默认去除标识（符合国内《人工智能生成合成内容标识办法》要求）。
- **上线前合规动作**（不在本轮技术实现范围，作为里程碑记录）：完成个人信息保护影响评估、确认所用模型完成对应生备案、按业务实际情况完成生成式人工智能服务登记、产品内展示模型名称及备案/登记编号。

---

## 十一、核心指标埋点

对齐产品侧确认的完整漏斗，服务端 + 客户端埋点覆盖以下节点：

```
进入首页 → 开始问卷 → 完成基础问卷 → 完成登录 → 同意照片处理 → 上传照片
→ AI分析成功 → 查看免费诊断 → 查看付费墙 → 完成订阅 → 查看完整目标图
→ 完成首个任务 → 使用目标图更新 → 进入下一阶段 → 第二周期续订
```

关键指标（服务端计算，避免纯客户端埋点丢数据）：首页到问卷开始率、问卷完成率、登录完成率、人脸授权率、照片上传成功率、AI分析成功率、目标图生成成功率、目标图质量检查通过率、免费诊断到付费转化率、首任务24小时完成率（**核心价值指标**）、每周目标图更新使用率、首周期取消率、第二周期续订率、退款率、数据删除率、每免费用户模型成本、每付费用户模型成本、单付费用户毛利。

`WorkflowRun.cost` 与 `Order.amount` 是成本/毛利核算的两个数据来源，需要在同一用户维度上可关联查询。

---

## 十二、部署

- 服务端与数据库：国内云（阿里云或腾讯云），需完成 ICP 备案。
- 对象存储：同厂商 OSS/COS，与计算资源同地域以降低延迟和流量成本。
- 模型调用：首版默认国内模型服务，直连无需代理；架构预留海外模型接入开关（需评估合规与访问链路，非首版必需）。
- 环境划分：dev / staging / production，Prisma migration 走 staging 验证后再上生产；EAS Build 对应管理 iOS/Android 多渠道构建产物。
