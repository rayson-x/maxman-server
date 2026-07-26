> This change documents work already implemented and empirically tested this session (spike-style, ahead of the Fastify/Prisma/BullMQ scaffolding in `add-mvp1-core-flow`). All items below are complete; checklist reflects what was actually built, for review/archival purposes.

## 1. Shared Infrastructure
- [x] 1.1 Typed env loader (`src/config/env.ts`) covering deepseek/zhipu/aliyun/volc/hunyuan/aliyunOss config
- [x] 1.2 Durable task ledger (`src/lib/taskLedger.ts`) — `recordSubmitted`/`recordProgress`/`recordResult`/`getEntry`/`listPending`
- [x] 1.3 FIFO rate limiter (`src/lib/rateLimiter.ts`), wired into `signedRequest.ts`'s `callVolcVisualAPI` at a configurable min-interval (default 600ms)
- [x] 1.4 OSS upload helper (`src/lib/ossUpload.ts`) using official `ali-oss` SDK

## 2. Composition Root & DI
- [x] 2.1 `src/features/appearance-agent/composition.ts` — config-driven `pick()` resolver + singleton caching, the only file reading `ACTIVE_*_PROVIDER` env vars
- [x] 2.2 All 7 tool factories rewritten to accept their provider as a constructor argument (no internal registry imports)
- [x] 2.3 `agent.ts` rewritten as `createAppearanceAgent(deps: AppearanceAgentDeps)` factory
- [x] 2.4 `resetProviderRegistry()` for test isolation

## 3. Vision Analysis Provider
- [x] 3.1 Zhipu GLM-4V-Flash implementation — confirmed working
- [x] 3.2 Qwen-VL-Plus implementation — confirmed working (after DashScope console model enablement)
- [x] 3.3 Hunyuan-vision implementation — blocked on invalid API key, not resolved this change

## 4. Image Edit Provider (img2img)
- [x] 4.1 Volcengine SeedEdit 3.0 (`seededit_v3.0`) implementation — confirmed working, including a dedicated hairstyle-change validation (3 distinct instructions against the same source face, strong identity preservation confirmed)
- [x] 4.2 Qwen wanx2.1-imageedit implementation — code verified against official docs (model id, path, body shape all correct), blocked on DashScope model-specific access

## 5. Clothing Swap Provider
- [x] 5.1 Volcengine `dressing_diffusion` (V1) implementation — confirmed working end-to-end with synthetic model+garment photos (OSS-hosted), correct req_key and Model/Garment body shape per official doc
- [x] 5.2 Hunyuan clothing-swap — confirmed non-viable (official SDK inspected, no image-input capability exists)

## 6. Text-to-Image Provider
- [x] 6.1 Zhipu CogView (`cogview-3-flash`) implementation — confirmed working, sync call

## 7. Text Planning / Recommendation / Review Providers
- [x] 7.1 `CandidateTaskCatalog` seed data (hair + outfit_accessory domains, ~9 entries incl. 1 `isRecommended=false` exclusion example)
- [x] 7.2 `TextPlanningProvider` (DeepSeek, catalog-constrained scoring via `generateObject`) — confirmed working after fixing (a) DeepSeek's "prompt must contain the word json" requirement and (b) adding an explicit JSON key/type template to get schema-conformant output
- [x] 7.3 `FreeRecommendationProvider` (DeepSeek, unconstrained suggestions)
- [x] 7.4 `AdversarialReviewProvider` (DeepSeek, skeptical judge between constrained and free outputs — feasibility/improvement-rate scores + per-suggestion verdicts)

## 8. Mastra Tools & Agent
- [x] 8.1 `analyze-appearance-photo`
- [x] 8.2 `edit-appearance-image`
- [x] 8.3 `swap-outfit`
- [x] 8.4 `generate-reference-image`
- [x] 8.5 `recommend-appearance-directions`
- [x] 8.6 `suggest-unconstrained-directions`
- [x] 8.7 `adversarial-review-recommendations`
- [x] 8.8 Agent prompt covering all 7 tools' usage rules and the mandatory constrained→free→adversarial-review sequencing

## 9. Validation
- [x] 9.1 End-to-end agent test: photo analysis → hairstyle img2img edit (multi-tool sequencing, unprompted)
- [x] 9.2 End-to-end agent test: illustrative reference-image generation with correct "not a personalized result" disclaimer
- [x] 9.3 End-to-end agent test: catalog-constrained recommendation across hair + outfit_accessory domains
- [x] 9.4 End-to-end agent test: full constrained + free + adversarial-review pipeline, confirmed the agent never surfaces unvetted free suggestions
- [x] 9.5 Direct (non-agent) provider tests for every vendor implementation above
- [x] 9.6 `npx tsc --noEmit` clean after every structural change
- [x] 9.7 `openspec validate add-appearance-agent-foundation --strict`

## 10. Follow-up (not done in this change)
- [x] 10.1 ~~Update `add-mvp1-core-flow`'s Open Questions~~ — **已由取代方案承接**：`add-mvp1-core-flow` 已归档为 superseded，供应商实测结论记在 `archive/2026-07-26-superseded-add-mvp1-core-flow/SUPERSEDED.md` 与新提案 `add-mvp1-backend-flow/design.md` 的实测数据汇总表
- [~] 10.2 Enable `wanx2.1-imageedit` in the DashScope console (user action) — 需用户在控制台操作，agent 无法完成
- [~] 10.3 Regenerate a valid Tencent Hunyuan API key (user action) — note this does NOT make Hunyuan viable for clothing-swap regardless — 需用户在控制台操作，agent 无法完成
- [x] 10.4 taskLedger 迁 Postgres — 抽出 `TaskLedger` 接口 + 文件版/Postgres 版双实现，经 `setActiveTaskLedger` 由组装根注入。**两套实现跑同一套 10 项断言全部通过**（行为一致才能保证「测试用文件版、生产用 PG 版」不出偏差）；实质收益是跨进程可见——API 提交的任务 worker 能查到
- [x] 10.5 限流分层 — 队列层（Redis backed，跨进程，权威）负责任务级并发=1；进程内限流器保留为**不经队列的调用路径**（测试/运维脚本）的兜底，可用 `VOLC_SKIP_INPROCESS_RATE_LIMIT=1` 在 worker 内关闭避免双重节流
- [x] 10.6 `CandidateTaskCatalog` 扩展到非风格领域 — 24 条入库（21 可推荐 + 3 显式排除），覆盖面部仪容/护肤/体态/健身/气味/口腔/其他 7 个领域。`applicableStageRange` 按**时间尺度**填并验证落位正确（阶段0=当天仪容清理，阶段3=力量训练与牙齿矫正）。**3 条明确排除项保留而非删除**（Mewing / 下颌线训练器 / 面部瑜伽）并写明原因——防止后续 LLM 或新同事把它们重新「发明」回推荐列表；已断言它们不会出现在任何用户方案里。12/12 集成断言通过，含「7 条 general_best_practice 任务全部为 optional」
- [~] 10.7 ~~把 `getAppearanceAgent()` 接进 Fastify `workflows/` 层~~ — **判定为已被取代，不再需要。**

  实测确认（grep 全量源码）：生产代码中**无任何地方调用 `getAppearanceAgent()`**，7 个 Mastra tool 也只被 `agent.ts` 装配、无生产引用。全部生产路径（steps / services / routes）直接调 provider。

  这不是遗漏，是 `add-mvp1-backend-flow` tasks 9.5 的决策自然导出的结果：对话入口刻意采用**确定性意图分类**而非 agent 自主 tool-calling——动作集有限且已知（改风格/否决方向/调权重/问解释/请求重生成），让 LLM 每轮自主判断只会引入不可预测的成本与延迟（实测见过 agent 在工具报错后用 4 种措辞重试同一工具），而收益为零。

  **agent 层已经完成了它真正的历史任务**：用真实 API 逐个验证了 7 个 provider 可用（含证伪 Hunyuan 换装能力缺口、确认 SeedEdit 多变化累加可行、测出并发=1 硬约束）。这些结论已沉淀进 `add-mvp1-backend-flow/design.md` 的实测数据表，价值已入账。

  **保留它作为内部探索工具**（4 个测试脚本仍在用）——接入新供应商或探索新能力时，agent + tool 的组合仍是最快的验证方式。但不应把它接进 Fastify 假装承担生产流量。
