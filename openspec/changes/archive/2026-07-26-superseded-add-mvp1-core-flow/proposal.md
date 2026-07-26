# Change: MVP1 核心流程（Web + Server）—— 测评 → AI分析推荐 → 生成方案

## Why

产品需要先验证"AI 分析质量是否靠谱、业务流程是否走得通"，而不是先把原生App、支付订阅、短信登录这些外围体验做完整。这些外围能力开发成本高（多渠道支付集成、App Store审核周期、原生构建），但对验证核心假设（AI 能不能生成让用户觉得靠谱、可执行的形象改善方案）没有直接帮助。因此把 MVP 范围收窄到 Web + Server，跑通"问卷+照片 → AI分析 → 分阶段方案 → 任务打卡 → 阶段解锁"这条主链路。

## What Changes

- 新增匿名身份识别（`device_session_id`），不接短信登录
- 新增问卷提交能力（基础低敏问卷 + 完整问卷）
- 新增照片上传能力，含人脸/照片信息独立同意面板、客户端本地人脸关键点测量（MediaPipe Tasks Vision JS）
- 新增多层内容安全审核管道（输入/输出图片与文本）
- 新增 AI 分析编排能力：`AnalysisJob` 状态机 + Mastra workflow（视觉分析→形象档案→并行方案生成→规则引擎优先级排序→文字诊断）
- 新增分阶段方案能力：`AppearancePlan`/`Stage`/`StageTask`，阶段任务扁平清单（不按日期分配）、阶段解锁规则（本阶段全部核心任务完成，可选任务不影响解锁）
- 新增目标图生成能力：基于原始基准照片+累计变化清单（`ChangeManifestEntry`）的 img2img 生成，含阶段首次生成（免费）、用户主动重新生成、进度复检校准三种触发场景
- 新增数据隐私能力：分级同意记录、异步级联删除
- **不包含**（明确排除，留给下一轮）：短信登录、JWT鉴权、支付/订阅、每周生成额度限制、原生App客户端

## Impact

- Affected specs（新增能力，均为 ADDED，无既有 spec 可改）：`anonymous-session`、`intake-questionnaire`、`photo-intake`、`content-moderation`、`appearance-analysis`、`appearance-plan`、`target-image-generation`、`data-privacy`
- Affected code：全新项目，无既有代码库；本次建立 Next.js 客户端骨架、Fastify 服务端骨架、Prisma schema、BullMQ 队列 worker 骨架、Mastra workflow 骨架
- 参考文档：`docs/mvp-plan.md`（范围界定）、`docs/technical-architecture.md`（完整目标架构）、`docs/product-ui-plan.md`（页面与文案设计）
