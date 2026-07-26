# Change: 可替换的方案推荐能力

规范文本见 `../../../docs/specs/pluggable-style-recommendation.md`。

## Why

S3 推荐当前是确定性匹配（脸型过滤 → 发量约束 → 加权打分），
依赖的 `StyleProfileEntry` 为空，运行时装载的是 11 条测试占位数据，
来源字段标着 `test_fixture_not_research`。

等本地风格数据、匹配规则、风格向量、调研评分齐备后再实施，
会让整条业务链路长期停在半成品状态。

## What Changes

先用多模态 Agent 作为推荐知识的实现，跑通完整流程；本地数据到位后只替换 provider adapter，
不修改采集、候选展示、用户选择、出图与方案落地链路。

责任分成两类：

| 类型 | 实现方式 |
|---|---|
| 推荐、排序、理由、穿搭建议、主观协调判断 | 多模态 Agent 提供，标注来源与验证等级 |
| 同意、权限、幂等、候选归属、费用状态、删除、内容标识 | 代码与数据库保证 |

具体变更：

- 新增 `RecommendationApplication` 作为唯一对外入口，承载抢占、幂等、照片授权、
  输出校验、渲染指令构建；固定管道与将来的对话 tool 都只调用它
- 发型与穿搭各一个 provider adapter，输入按域拆分；实现为 `multimodal-agent`
- 新增 `RecommendationSet` / `RecommendationCandidate` / `GeneratedAsset` 三张表
- 候选集抢占发生在付费调用之前，同一 `computationKey` 只触发一次 provider 调用
- provider 返回受限的 `visualDirection`，最终图生图指令由应用模块用固定模板构建
- 每个候选集返回 `capabilityStatus`，标明知识来源与各项验证等级
- 所有生成图片先建 `GeneratedAsset` 再签发读取 URL，使删除链路可枚举 OSS 对象

## Impact

- Affected specs: `style-recommendation`
- 新增：应用模块、两个 provider adapter、三张表及迁移
- 修改：S3 推荐步骤改为调用应用模块；容器装配；预览图落库路径
- 本地目录为空、风格向量缺失、双审美调研不存在，均不阻断实施
