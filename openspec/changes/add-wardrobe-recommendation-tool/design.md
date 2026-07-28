# Design: 系统衣柜推荐与业务流程接线

## 1. 边界：一个公开工具，多个入口

对外只公开以下能力：

```ts
recommendWardrobe({
  userId,
  planId?,
  profile,
  request: {
    selectedStyleIds: string[],
    requestedLookCount?: number,
    includeExplorationStyles?: boolean,
    includeSupply?: boolean,
  },
}): Promise<WardrobeRecommendationBundle>
```

HTTP workflow 与 Mastra Agent 都调用这个方法；它们不得自行调用目录检索器、排序器或 LLM
provider。`styleIntent` 不放进可被覆盖的 profile：`request.selectedStyleIds` 是用户显式
选择，结果必须包含它们。

内部顺序固定：

```text
授权/归属 + 幂等
  → resolveStyleIntent
  → retrieveStyleFormulas
  → retrieveWardrobeSlots
  → rankWardrobeLooks
  → 可选 explainBundle（只解释，不改候选）
  → resolveAssetsAndSupply
  → 持久化并返回
```

## 2. 数据与部署边界

内容源当前位于 `client/data/style-annotation/`：

- `wardrobe-items-cn.json`：169 个系统衣柜原型与稳定 `wardrobeItemId`；
- `style-wardrobe-profiles-cn.json`：风格、公式及槽位；
- `style-system-retrieval-index-cn.json`：文本检索块；
- `wardrobe-image-assets-cn.json`：图片路径与真人试穿状态；
- `wardrobe-supply-map-cn.json` / `market-sku-candidates-cn.json`：品牌、版型与供给候选。

服务端新增受版本控制的构建脚本，把经 schema 校验的内容编译成
`server/src/features/wardrobe-recommendation/data/generated/wardrobe-catalog.v<N>.json`。运行时
只读取该快照；CI 校验所有引用的 `wardrobeItemId`、公式槽位、资产和 SKU 关联均存在。
这避免客户端与服务器独立部署后相对路径失效。

## 3. 检索、排序与 LLM 权限

输入特征分为：

- 稳定档案：年龄段、身高体重/体型、脸型、发量与发际线、预算；
- 当次情境：场景、季节、温度带、城市、正式度；
- 强偏好：已选/厌恶风格、已选择/收藏/替换单品、明确不喜欢；
- 显式风格意图：用户选择的风格（权威）及可选探索风格。

确定性路径先锁定所选风格的公式和各槽位可用单品，再计算：

```text
score = 风格一致性 + 场景适配 + 季节适配 + 强偏好
      + 软体型/脸型/发量适配 + 供给可用性
      - 维护成本 - 槽位冲突
```

体型、脸型、发量/发际线都是**排序特征**，不是对所选风格的硬拦截。若条件不理想，返回
该风格的「适配版」公式、替换项和说明，并可并列给出更省心的探索风格。

LLM 只接收已排序的风格、公式、槽位及可选 `wardrobeItemId`，只可生成中文解释和从集合中
选择的 ID。服务端在写入前验证所有 ID；ID 不存在、遗漏已选风格或试图新增槽位时，丢弃
LLM 选择并保留确定性结果。LLM 不可用时，采用目录文案/规则模板降级。

## 4. 持久化与反馈

系统衣柜、公式、资产与排序规则均为版本化 JSON，不进入数据库。推荐响应携带目录版本，
因此同一版本下可由相同档案重新计算。数据库继续只保存已有的用户档案、方案、已选风格和
发型；第一版不新增推荐集合或反馈表。

后续需要个性化时，单独增加 `look_selected`、`item_selected`、`item_replaced`、`saved`、
`explicit_dislike`、`try_on_saved` 等强反馈事件。初版不把曝光、滚动或浏览写入偏好，且不
允许任何用户事件修改系统衣柜 JSON。

## 5. 资产、供给与试穿

每个槽位返回 `wardrobeItemId`、替换项 ID、目录图资产与可选的品牌/SKU 候选。目录图的
`localPath` 是客户端展示资源；只有 `displayStatus=public_url_ready` 的服装单品可传给真人
换装，鞋、配饰及无公开 URL 的单品只作目录展示，不能伪装成可试穿素材。

## 6. 业务流程串联

```text
首次分析
  → 用户选风格（可多选，至少一个）
  → 用户选对应发型
  → workflow 组装档案/场景/季节
  → recommend-wardrobe
  → 展示：主搭 + 2 备选公式；每槽 3–5 个替换项
  → 用户确认一套及具体单品（写强反馈）
  → 若所选服装都有 public_url_ready：申请真人试穿
  → 将确认的 look 写入方案任务/目标图上下文
```

对话 Agent 路径只把「收集到的 profile 与选定风格」传给同一工具，返回相同 bundle；它不能
绕过 `RecommendationApplication` 直接给用户编一套衣服。

## 7. 迁移策略

1. 先加目录构建、只读匹配器及单元测试；保持既有自由文本穿搭路径可用。
2. 在固定流程的「已选发型之后」调用 `recommendWardrobe`，将 bundle 与现有穿搭候选并行返回。
3. 客户端改为确认 formula/slot item 后，将该结果作为唯一的方案落地穿搭事实。
4. 流量验证后把 `catalog_matching` 设为默认；`multimodal_agent` 只保留为显式降级并如实标记。

不迁移或重写当前用户的 `RecommendationCandidate`，避免把旧自由文本伪装成系统衣柜单品。
