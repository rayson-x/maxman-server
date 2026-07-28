## Context

推荐文字与图片成本、可靠性不同。`RecommendationSet`/`RecommendationCandidate` 是选择事实，
`GeneratedAsset` 是可选衍生物；因此图片不得成为选择或方案物化的前置条件。

## Decisions

- 复用 image-generation 队列、Redis 全局图片并发闸门和 `renderPreviewsStep`，不新增第二个渲染器。
- 在资产记录中保存 recommendation set、style、hairstyle、outfit、基准照、provider/model、render spec
  与上游 generation；只为 active 资产签发读取地址。
- 用户改变风格或发型时，同一事务 supersede 下游集合、清空下游选择、标记预览资产 invalidated；
  worker 在提交、落图和 partial-result 回写前验证上下文仍有效。
- 公共响应仅包含可展示 preview 与中性补图引导。原始错误、校准状态与重试信息仅存内部 `missing`/审计。

## Risks / Trade-offs

- 当前目录未必满足每个风格最少 2–3 个校准候选；不足时保留文字候选而不尝试图片生成。
- 全身照缺失时不得由正面照伪造全身穿搭；返回文字与中性补拍引导。
