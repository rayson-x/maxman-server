## Context

原链路把云端语义分析（S2）和发型推荐（S3）拆成两次视觉调用，但 S2 的六个语义字段
没有独立消费者，只被 S3 使用。这会重复发送同一张正面照，也可能让两次模型判断互相矛盾。

## Decisions

### 单次首轮 tool call

`analyzeVisionStep` 只读取并规范化客户端测量值，不再调用云端视觉 provider。
`createHairstyleMultimodalAgentProvider` 对照片执行唯一一次强制 `submit_first_round` tool call，
其显式 schema 同时返回：

- `faceAnalysis { narrative, structuredSemantic }`：面向用户的人脸叙事与供下游复用的六个语义字段；
- `styleRecommendations[3..4] { id, nameZh, description, rationale }`：可供用户选择的风格层；
- `hairstyleSuggestions[]`：仍交由 `RecommendationApplication` 的确定性发量/遮额约束复核。

结果随 `RecommendationSet.injectedContext` 持久化，并在 initial job 的 `partialResult` 中公开为：

```ts
{
  planId,
  vision: { geometry, hairSignals, clientSignals, structuredSemantic, hasFullBody },
  faceAnalysis: { narrative, structuredSemantic },
  styleRecommendations: [{ id, nameZh, description, rationale }],
  recommendation: { setId, candidates, capabilityStatus, reused }
}
```

重试和并发跟随者读取同一推荐集合，因此不会为补齐这两段再次调用模型。

### 风格选择与状态

`AppearancePlan.selectedStyle` 保存由首轮 tool schema 验证过的完整方向对象。
`POST /plans/:planId/select-style-direction { styleId }` 只接受最新成功首轮 job 的
`styleRecommendations` 中存在的 id；任意自造方向返回 422。

选择发型及请求穿搭都检查该字段。未选风格时，穿搭端点返回
`422 { error: "style_not_selected" }`；worker 也做同样的防御检查。

### 第二轮穿搭 tool call 与候选集合接缝

穿搭 provider 也强制调用 `submit_outfit_recommendations`。它收到已选风格、已选发型、
首轮的客户端几何/发量/语义信息及全量 `catalogVariants`。候选集合在本版只作为带四轴的
参考信息，不做阈值过滤；协调状态明确标为 `agent_estimated`。

未来接内部向量库时只替换 orchestrator 构造 `catalogVariants` 的来源；provider 的 tool
schema、`RecommendationApplication` 入口和客户端返回结构均不变。

### 不做族裔分类

两轮 prompt 和 schema 均不含族裔字段。身份保持由图像编辑约束承担，肤色、发质与几何
信息仅取自已同意且已验证的客户端/首轮输入。
