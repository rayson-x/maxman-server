# WIG-006 — 把假发方案推导迁到分段式（dual-source）链路上

**Spec**: `docs/specs/wig-assisted-hairstyle-options.md`
**Blocked by**: 无（但见下方「注意别人正在动的地方」）
**Triage**: ready-for-agent
**优先级**: 高 —— 在 WIG-005 回填标注**之前**必须解决，否则功能上线即无输出

## 问题

WIG-004 的接线放在了 `initial_analysis` 里 `recommendStep` 那一支，而**这一支在生产中走不到**：

- `createDualSourceWorkflowApplication` 无条件返回对象，所以 `jobOrchestrator.ts` 里
  `if (dualSourceWorkflow)` 恒真，该分支在 `recommendStep` 之前就 `return` 了。
- 生产链路是分段式的：`initial_analysis` 只产**风格方向**；发型候选在用户选定风格后的
  `hairstyle_recommendation` job 里产出。
- 而且那条链路上的发型可行集**不是**「LLM 先产候选、规则再事后剔除」，而是
  `projectHairstyleCatalog`（`features/recommendation-catalog/hairstyleReadiness.ts`）的
  **确定性目录投影** —— 它已经在内部调用 `applyHairConstraint`，并且**已经返回
  `excluded`（含逐条原因）**。

附带一个次生问题：`plans.ts` 在用户选定风格方向时会把该方案下**所有** `hairstyle` 集合
置为 `superseded`。即便第二轮的集合存在，其候选也无法再被选中。

## 要做什么

把假发方案的推导从 `initial_analysis` 移到 `hairstyle_recommendation`。那里已经拿到
`hairSignals`（`jobOrchestrator.ts` 内该 handler 明确校验其存在），是正确的落点。

**大概率能顺手简化掉一次付费调用**：既然这条链路的可行集来自确定性目录投影，那么
「两个前提各投影一次、取差集」是纯计算 —— 不需要第二次模型调用。请先验证
`projectHairstyleCatalog` 是否就是喂给最终候选的那个池子（dual-source 的 A 通道是 LLM、
B 通道是目录，两者会被比较合并），确认后再决定：

- 若是：`deriveWigOptions` 的输入改为两次投影的结果，**删掉** WIG-004 里那次
  `premise: "ample"` 的额外 `recommendStep` 调用，以及 spec 中「多一次付费调用」的代价说明。
- 若否：仍在这条链路上补一轮 ample 前提的调用，但要重新确认它的抢占键
  （`computationKey` 形如 `dual-source:hairstyle:hairstyle:${jobId}`，**按 jobId 唯一**，
  同一 job 内跑两个前提会撞键）。

`deriveWigOptions`、`computeHairConstraint` 的前提入参、属性表的假发维度、变更清单的
达成路径**都不需要改** —— 它们与链路无关。要改的只是「候选从哪来」。

## 注意别人正在动的地方

根仓库当前有未提交的改动落在 `client/data/style-annotation/style-hairstyle-relations-cn.json`
与 `client/scripts/build-style-hairstyle-relations.mjs` —— 正是这个目录投影的数据来源。
动 `hairstyleReadiness.ts` / `runtimeHairstyleCatalog.ts` 前先确认那边已落定，避免撞车。

另外 `src/routes/styleDirectionSelection.test.ts` 有一个**既有失败**（期望 410、实到 422），
就在风格选定 / 集合失效这块逻辑上。它在 `e372e46` 基线上同样失败，不是本能力引入的，
但改这块之前值得先弄清它。

## 验收

- 生产链路（分段式）下，满足开放条件的用户能真正拿到假发方案。
- 属性表假发维度仍全空时，输出仍为空且行为无变化（fail closed 不变）。
- 风格方向选定导致的集合失效不会让假发候选变成不可选。
- 若走「确定性双投影」路线：不新增任何模型调用，并同步更新 spec 里的代价说明。
- `npm test` 不新增失败。
