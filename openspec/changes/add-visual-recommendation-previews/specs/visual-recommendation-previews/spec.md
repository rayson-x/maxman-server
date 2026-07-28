## ADDED Requirements

### Requirement: 文字候选优先于可选真人预览

系统 SHALL 在每个推荐阶段先持久化并返回可选择的文字候选。图片生成 SHALL NOT 阻止候选选择、
方案物化或阶段推进。

#### Scenario: 全部发型或穿搭图片失败

- **WHEN** 对应文字候选集已 ready 而所有图片 provider 调用失败
- **THEN** preview job 以 `completed_partial` 收尾，用户仍可选择候选，原始失败原因只保留在内部审计

### Requirement: 双源预览遵循选择顺序

系统 SHALL 在已选风格后生成已校准发型的可选预览，并在已选发型、未选穿搭时生成已校准穿搭的
可选预览。

#### Scenario: 用户选择发型前比较穿搭

- **WHEN** 用户已选发型且当前穿搭候选集 ready
- **THEN** 双源穿搭预览端点创建批量 preview job，且不要求 `selectedOutfitId`

### Requirement: 预览资产不可跨上游选择复用

系统 SHALL 将每张预览绑定推荐集合、上游选择、基准照片、provider/model 与渲染规格版本；
上游选择变化 SHALL 使下游预览不可读取且拒绝晚到回写。

#### Scenario: 用户改选发型

- **WHEN** 用户从一个发型候选改选另一个候选
- **THEN** 旧穿搭候选集和预览资产失效、已选穿搭清空，旧 job 不得重新写入用户可见结果
