# Change: 增加可选的真人发型与穿搭比较预览

## Why

双源推荐已将风格、发型、穿搭拆为三次用户选择，但当前只交付文字候选；穿搭效果图仍要求用户
先选择穿搭，无法辅助选择，并会把供应商/校准原因透传给用户。

## What Changes

- 在选定风格后增加可选的 `hairstyle_preview_generation`，为已校准发型生成真人比较图。
- 双源 `outfit_preview_generation` 改为选定发型后、选定穿搭前批量生成已选发型加穿搭效果图。
- 为预览图持久化选择上下文、校准版本和 active/invalidated 生命周期；上游改变时原子失效下游。
- 图片始终为增强项：文字候选先可选，图片失败仅内部审计并以 `completed_partial` 结束。

## Impact

- Affected specs: new `visual-recommendation-previews`; modifies `two-round-style-agent` selection ordering.
- Affected code: Prisma, recommendation selection, image renderer, job orchestrator, analysis-job routes and polling serialization.
- **BREAKING (flag-on only):** 双源 `/outfit-previews` 不再要求已选择穿搭；关闭 flag 时保持 legacy 行为。
