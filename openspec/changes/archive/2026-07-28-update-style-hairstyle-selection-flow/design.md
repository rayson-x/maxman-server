## Context

首轮调用已经能同时生成风格方向和发型建议，但两个数组彼此独立；编排器随后立即对所有
发型候选调用图像编辑。这样用户看起来是在“先出发型图、再选风格”，并会为未选方案付费。

## Decisions

### 配对候选

首轮 tool schema 的每个发型建议带 `styleId`，必须匹配同一响应的一个风格方向。该关系
随 `RecommendationCandidate.styleDirectionId` 持久化并返回给客户端；服务端不按名称推断
关系。首轮要求三个风格方向，并为每个方向至少给一个通过 schema 的发型建议。

### 原子选择

`POST /plans/:planId/select-style-hairstyle` 接收 `{ styleId, candidateId }`。它在同一事务中
验证首轮曾提供该风格、候选属于该方案的 ready 发型集合且 `styleDirectionId` 相同，然后写入
`AppearancePlan.selectedStyle` 与 `selectedHairstyleId`。旧的逐步选择端点保留兼容，但同样
拒绝跨风格选择。

### 延迟出图

`initial_analysis` 在写回首轮结果后结束，不调用 `renderPreviewsStep`。这避免为用户没有选择
的发型消耗图像生成配额。穿搭仍只在已选组合后生成；本变更不增加发型图片的单独生成入口。

## Non-goals

- 不实现可购买商品 SKU、价格或电商链接。
- 不重新引入独立云端视觉分析调用。
