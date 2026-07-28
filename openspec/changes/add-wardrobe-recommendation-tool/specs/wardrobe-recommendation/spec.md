## ADDED Requirements

### Requirement: 系统衣柜推荐只有一个公开业务入口
系统 SHALL 通过 `recommend-wardrobe` 提供系统衣柜推荐；固定业务流程与对话 Agent SHALL
调用同一个应用入口，且 SHALL NOT 各自直接调用目录检索、排序或 LLM provider。

#### Scenario: 固定流程请求推荐
- **WHEN** 用户已经选择风格和发型，流程需要穿搭建议
- **THEN** 流程将档案与场景交给 `recommend-wardrobe` 并返回其 bundle

#### Scenario: 对话 Agent 请求推荐
- **WHEN** Agent 已收集同一用户档案、场景和选定风格
- **THEN** 它调用 `recommend-wardrobe`，得到与固定流程相同契约的 bundle

### Requirement: 用户已选风格必须保留且适配条件为软排序
系统 SHALL 在结果中包含每个用户显式选择的风格。身体、脸型、发量/发际线、场景和季节
SHALL 调整公式及单品排序，但 SHALL NOT 因此删除用户已选风格。

#### Scenario: 用户选择的风格对当前档案不占优
- **WHEN** 该风格对用户体型或通勤场景得分较低
- **THEN** 系统返回该风格的适配版公式、替换项与原因，并可额外给出探索风格

#### Scenario: 返回探索风格
- **WHEN** 请求允许探索风格
- **THEN** 探索风格与用户选择明确区分，且不替代用户选择

### Requirement: 推荐只能引用版本化系统衣柜目录
系统 SHALL 从已校验、版本化的服务端衣柜目录中引用风格、公式、槽位和单品；运行时 SHALL
NOT 依赖客户端目录的相对路径，且 SHALL NOT 返回目录外的 `wardrobeItemId`。

#### Scenario: 目录引用断裂
- **WHEN** 构建时发现公式槽位、资产或供给映射引用不存在的单品
- **THEN** 目录构建失败且该快照不能部署

#### Scenario: 返回单品
- **WHEN** 推荐 bundle 含单品或替换项
- **THEN** 每个 ID 都能在该 bundle 标注的目录版本中解析

### Requirement: 公式和槽位候选由代码确定，LLM 仅可解释
系统 SHALL 先由代码选出主搭、备选公式及每槽可选单品。LLM 若启用，只能解释或在输入候选
集合内选择，服务端 SHALL 拒绝其新增未知单品、遗漏已选风格或改变槽位结构的输出。

#### Scenario: LLM 返回目录外单品
- **WHEN** LLM 输出不在输入候选集合的 `wardrobeItemId`
- **THEN** 系统丢弃该选择并保留确定性排序结果

#### Scenario: LLM 不可用
- **WHEN** 解释 provider 不可用
- **THEN** 系统用目录文案/规则模板返回完整结构化 bundle，不中断推荐

### Requirement: 结果支持主搭、备选与单品替换
系统 SHALL 为每次推荐返回一套主搭和两套备选公式；每个公式槽位 SHALL 返回一个主单品与
3 至 5 个来自同一可用集合的替换项。

#### Scenario: 用户替换一个槽位单品
- **WHEN** 用户从该槽位替换项中选择另一个单品
- **THEN** 系统记录强反馈，且替换后的单品仍属于该公式的可用集合

### Requirement: 反馈只由强意图事件驱动
系统 SHALL 仅记录用户确认 look、选择单品、替换单品、收藏、明确不喜欢或保存试穿等强
意图事件以更新后续排序；系统 SHALL NOT 将曝光、滚动或浏览作为初版偏好训练信号。

#### Scenario: 用户明确不喜欢一个单品
- **WHEN** 用户提交明确不喜欢事件
- **THEN** 该事件存入推荐审计并在之后相同场景的排序中作为负偏好

### Requirement: 资产展示能力与真人试穿能力分开
系统 SHALL 在每个单品返回目录展示资产状态。只有具有公开可访问服装图片的单品可用于真人
试穿；鞋、配饰和无公开 URL 的单品只能作为目录展示，SHALL NOT 被提交给真人换装 provider。

#### Scenario: 所选 look 含不可试穿的资产
- **WHEN** look 中任一需要换装的服装单品没有公开 URL
- **THEN** 系统展示目录图并拒绝启动该 look 的真人试穿，同时说明不可用原因
