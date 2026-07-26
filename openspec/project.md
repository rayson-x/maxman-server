# Project Context

## Purpose

BetterMeet（内部代号，最终消费者品牌名待定，见 `../../docs/product-ui-plan.md` 顶部说明）是一款面向男性用户的 AI 形象改善产品。核心价值主张：输入现状（照片+问卷）→ AI 生成分阶段的现实可执行改善方案（现状→阶段目标→现在该做什么）→ 用户按阶段推进，逐步解锁下一阶段目标图和任务。

产品定位刻意避免"承诺变帅/整容级效果"，强调"现实可执行"和"模拟效果标注"，见 `../../docs/product-ui-plan.md` 的文案克制原则。

**当前阶段（MVP1）目标**：先跑通"测评 → AI分析推荐 → 生成方案"这条核心业务链路，验证 AI 输出质量和业务流程本身，暂不做完整消费级体验（原生App、支付订阅、短信登录留到下一阶段）。

## Tech Stack

- 客户端（MVP1）：Next.js（React）+ TypeScript，响应式 Web
- 客户端（后续原生App，本轮不实施）：Expo（React Native）
- 服务端：Node.js + Fastify + TypeScript
- 数据库：PostgreSQL + Prisma ORM
- 队列：Redis + BullMQ（按任务类型分队列：moderation / text-analysis / image-generation）
- AI 编排：Mastra workflow，Model Provider 按能力拆分（VisionAnalysisProvider / TextPlanningProvider / ImageEditProvider / ImageModerationProvider / TextModerationProvider / EmbeddingProvider）
- 对象存储：阿里云OSS或腾讯云COS（私有Bucket+短签URL）
- 客户端本地人脸测量：MediaPipe Face Landmarker（Apache-2.0开源）；MVP1 用 Tasks Vision JS（浏览器WASM），后续原生App用 react-native-mediapipe，同一引擎不同运行时
- 部署：国内云（阿里云/腾讯云），需完成ICP备案；AI模型首版默认接入国内模型服务

## Project Conventions

### Code Style
- TypeScript 全栈，服务端与客户端共享类型定义时优先考虑 monorepo 结构（如有需要）
- 具体 lint/format 规则在实现阶段确定，本文档不预设

### Architecture Patterns
- **Mastra 只负责 AI 编排与推理，不持有业务状态**；每次 workflow 运行的结果、版本、成本同步落到 PostgreSQL 的 `WorkflowRun` 表
- **业务流程按"要不要 Agent 参与"明确分层**：问卷存储、内容安全API调用、优先级打分（固定加权公式）、阶段解锁判定、任务状态更新、订阅支付处理、数据删除级联清理——这些是纯业务逻辑，不经过 Mastra；只有视觉分析、方案文案生成、目标图生成、排序解释文案、LLM语境安全审查这几类才调用 Agent
- **AnalysisJob 是独立的任务追踪实体**，与 `AppearancePlan`（业务结果）分离；一个 AnalysisJob 内部可触发 1-2 个 `WorkflowRun`。四种 job_type：`full_analysis`（首次完整分析，产出阶段结构+候选任务池，不消耗额度）、`stage_unlock_generation`（进入新阶段首次生成，不消耗额度）、`user_regeneration`（用户主动重新生成，消耗每周额度）、`progress_recheck`（用户上传进度照片的免费校准，不消耗额度）
- **方案生成分层策略**：`full_analysis` 一次性规划四个阶段的时间窗口和候选任务池（规则引擎已排序），但每个阶段的具体 `StageTask` 清单在用户实际进入该阶段时才生成（懒生成），与目标图的懒生成逻辑一致
- **目标图生成基于「原始基准照片 + 累计变化清单」，禁止链式使用上一阶段生成图作为输入**，避免身份漂移。`ChangeManifestEntry` 由用户完成 `StageTask` 时自动写入（任务预置 `change_description` 模板，不调用LLM）
- **`AppearancePlan` 每用户仅一条活跃记录**，`plan_version` 原地自增，不产生历史行；历史演变靠 `WorkflowRun` 审计追溯
- **付费墙/内容锁定在服务端字段级强制**：未解锁内容直接返回 `null` + `locked:true`，不依赖客户端隐藏
- **Provider 输出必须是业务层定义的 Schema**，不透传供应商原始响应
- **`StageTask` 区分 `simple`/`guided_selection` 两种交互类型**：`guided_selection`（如选发型）需要先在专门页面做决策，`selection_status`（待选择/已选定）与 `status`（完成状态）是两条独立状态轴——选定只代表决策完成，不代表真实变化已发生，`ChangeManifestEntry` 仍然只在 `status=done` 时写入。首版只有发型一个实例，是"任务→专门页面"的通用模式，后续可扩展到其他领域。

### 页面变更与后端同步纪律
产品/UI 讨论中确认的改动，必须区分两类，并且**确认后立刻同步进 schema/spec，不能只停留在对话记录里**：
- **纯 UI 重排**（合并页面、砍掉过渡页、简化视觉效果、去掉某个环节的展示）：不改变已收集的数据或可执行的动作，通常不需要动 schema/API。
- **引入新决策或新数据形状**（如新增一个需要用户选择的交互、新增一种任务分支）：必须同步更新 `docs/technical-architecture.md` 的 schema、对应 `openspec` capability 的 requirement/scenario、以及 `tasks.md` 的实现项，跑一次 `openspec validate --strict` 确认。判断标准：这个改动是否让"用户能做的事"或"系统要记录的数据"发生了变化，是则必须同步。
- 完整目标架构见 `../docs/technical-architecture.md`（本仓库内）；MVP1 与完整架构的差异对照见 `../../docs/mvp-plan.md`

### Testing Strategy
- 待实现阶段补充（当前为规划阶段）

### Git Workflow
- 待补充；遵循仓库根 CLAUDE.md（如有）的既有约定

## Domain Context

- **四个通用阶段**（按时间窗口而非领域划分）：阶段0（当天10-30分钟）、阶段1（1-7天）、阶段2（2-4周）、阶段3（6-12周）。用户勾选的领域（发型穿搭/护肤美妆/健身饮食）只是候选任务范围，具体任务混合分配到各阶段
- **阶段任务是扁平清单，不按日期分配**：一个阶段一份任务清单，用户在阶段时间窗口内自行安排进度；阶段解锁规则：本阶段**全部**核心任务（可能来自不同领域，如发型+穿搭同为核心）都完成才解锁，可选任务不影响解锁判定
- **免费 vs 付费边界**（完整架构；MVP1本轮不启用付费墙，全部内容对所有用户开放）：未订阅用户只能看免费文字诊断+标注清楚的通用风格占位图；订阅解锁完整方案内容
- **内容安全是多层管道**：客户端提示（非拦截）→ 输入图片内容安全API → 文本内容安全API → 模型生成 → 输出图片内容安全API → LLM语境安全审查 → 视觉质量/身份一致性检查 → 确定性规则最终阻断
- 详细产品UI流程、页面线框图见 `../../docs/product-ui-plan.md`

## Important Constraints

- 面向中国大陆用户，需符合《人工智能生成合成内容标识办法》（AI生成内容需显式+隐式标识）、《生成式人工智能服务管理暂行办法》（需完成服务登记）等法规
- 首版仅面向18岁以上用户，出生日期采集+自声明勾选
- 人脸/照片处理需要独立于总协议的显式同意面板，且可随时撤回；默认不用于模型训练
- 数据删除是异步操作（接口立即返回 pending，后台队列级联清理），需要在UI上明确告知用户
- MVP1 阶段不涉及真实支付资金流转，但仍然处理真实用户照片，隐私合规要求不能因为是MVP而降低

## External Dependencies

- 图像生成/视觉分析/文本安全审核模型：首版默认国内模型服务商（具体供应商待定，通过 Model Provider 抽象层可替换）
- 对象存储：阿里云OSS 或 腾讯云COS
- MediaPipe（Google，Apache-2.0开源）：客户端本地人脸关键点测量引擎
- MVP1 阶段不接入：短信服务商、支付渠道（Apple IAP/华为IAP/微信支付/支付宝）——见 `../../docs/mvp-plan.md`
