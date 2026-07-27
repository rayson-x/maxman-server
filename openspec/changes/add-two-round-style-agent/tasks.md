# Tasks: 两轮多模态 Agent（服务端）

> 客户端侧任务见 `client/openspec/changes/add-style-layer-and-face-signals/tasks.md`。
> 依赖：本变更的 1 与 2 独立；3 依赖客户端 1.x 的测算字段落地；4 依赖 3 定型。
> 每项完成跑 `npm run typecheck && npm run build`。

## 1. 已完成的前置修复（本轮已做）

- [x] 1.1 **穿搭协调链路 id 串线** —— `AppearancePlan.selectedHairstyleId` 存的是
      `RecommendationCandidate.id`，编排器却拿它去 `styleProfileEntry.findUnique({ id })`。
      实测三个真实方案：候选表命中 1、风格表命中 0。后果是 `coordinationAvailable` 恒为 false、
      `checkCompatibility()` 在主流程**一次都没被调用过**。
      新增 `resolveStyleEntryByName` / `toStyleVector`（styleProfile.ts）按名称解析
- [x] 1.2 两处死代码 —— 查出的 5 套带向量穿搭从未被使用；`catalogVariants` 参数从应用模块
      一路铺到 provider 签名，但编排器不传、provider 不读
- [x] 1.3 改为**不做向量过滤**：全量集合 + 四轴作参考交给 LLM（决策 2 有意放宽，见 proposal）
- [x] 1.4 穿搭 provider 补人脸信息（几何/语义/发量信号），复用首轮 `partialResult.vision`，
      不重复发起视觉分析
- [x] 1.5 `coordination` 状态改为如实的 `agent_judgement` + 真实原因
      （原文案"没有可信风格向量"是错的——向量一直都在，是 id 对不上）
- [x] 1.6 **补验证**：真实跑一次穿搭生成，确认人脸信息确实进了 prompt、模型确实用了全量集合
      （当前只有代码层面成立，实跑验证被打断未完成）

## 2. faceMetrics schema 放行客户端新增维度

- [x] 2.1 `schemas/intake.ts` 的 `faceMetricsSchema` 放行：视觉年轻程度、面部性别倾向、颧骨遮盖需求
- [x] 2.2 保持"结构必需、取值枚举约束"的既有口径，未知字段仍被剥离

## 3. 两轮合一 + 风格层

- [x] 3.1 `steps/analyzeVision.ts` 与 `steps/recommend.ts` 合并为一次多模态调用
- [x] 3.2 输出三段 `faceAnalysis` / `styleRecommendations` / `hairstyleSuggestions`
- [x] 3.3 发型建议仍过确定性发型约束（决策 6 不变）
- [x] 3.4 `AppearancePlan` 增加已选风格字段 + migration
- [x] 3.5 新增风格选定端点；未选风格时穿搭端点 422
- [x] 3.6 穿搭推荐入参补入已选风格 + 首轮结论
- [x] 3.7 `partialResult` 结构变更同步到 design.md 的契约段

## 4. tool call 封装

- [x] 4.1 两轮改为 tool call 调用，schema 显式化
- [x] 4.2 "候选集合来源"实现为可替换接缝，供后续内部向量数据库替换

## 5. 明确不做

- [x] 5.1 **不做族裔分类** —— 分类偏差与合规风险；身份保持交给 SeedEdit + negative prompt，
      肤色与发质由客户端直接测量提供

## 6. 验证

- [x] 6.1 每步 `npm run typecheck && npm run build`
- [x] 6.2 真实照片跑通首轮，人工核对人脸结论与风格推荐是否自洽
- [x] 6.3 全链路 E2E（含风格选定这一新端点）
