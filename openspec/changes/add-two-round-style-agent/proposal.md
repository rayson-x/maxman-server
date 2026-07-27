# Change: 两轮多模态 Agent（服务端）

> 本变更**只描述服务端**要实现的能力。客户端侧的测算扩充与风格选择屏见
> `client/openspec/changes/add-style-layer-and-face-signals/`。
> 跨端的流程决策见根目录 `docs/`。

## Why

`initial_analysis` 里有**两轮 LLM**：S2 云端语义分析（只取 6 个字段：
current_hairstyle / hairline_visibility / facial_hair / glasses / skin_tone / current_outfit），
再 S3 多模态发型推荐（照片 + 几何 + 语义 + 约束）。

S3 本来就是多模态、已经拿到照片，而 S2 的产出**全部只喂给 S3**——两轮之间没有其他消费者。
拆着调等于白付一次 vision 成本，且风格与发型的判断被切在两次调用里、无法互相自洽。

推荐链路还缺一层：风格向量四轴数据已填满（12 发型 + 5 穿搭），但主流程从不使用，
用户看到的只有「发型 → 穿搭」两层选择，没有可选的大风格。

穿搭推荐**完全拿不到人脸信息**（只有发型名 + 体型 + 场景 + 天气 + 预算），
而版型与配色本就该看脸型与肤色。

## What Changes

### 1. S2 与 S3 合并为一次多模态调用

一次调用产出三段：

| 字段 | 内容 |
|---|---|
| `faceAnalysis` | 人脸分析结论（给用户看的叙事段） |
| `styleRecommendations` | 3-4 个风格方向，供用户选择 |
| `hairstyleSuggestions` | 发型建议，仍过确定性发型约束（决策 6 不变） |

### 2. 新增风格层

- `AppearancePlan` 记录已选风格方向
- 新增选定端点，位于发型选择之前
- 穿搭推荐入参补入「已选风格 + 首轮结论」

### 3. 风格数据退为参考，不作过滤条件

风格向量**只随可选集合作为参考信息给模型**，不做阈值过滤。
库里仅 12 发型 + 5 穿搭，按四轴筛只能从本就很小的池子里再减
（实测「微碎盖」筛完剩 4/5，正式度靠边的发型可能剩 0-1 个），
等于用未校准阈值把候选饿死。

⚠ 这是对**决策 2**（"协调性必须编码在数据里，不能靠 LLM 判断审美"）的**有意放宽**，
不是漏做。数据量达到可过滤规模后回到确定性过滤——接缝保留，替换的只是"集合怎么来"。
**不写明这一点，下一个人会把它当漏做的 bug 改回去。**

### 4. 穿搭推荐收到人脸信息

复用首轮分析结果（`partialResult.vision` 里已存 geometry / hairSignals / structuredSemantic），
不重新发起视觉分析。

### 5. LLM 调用改 tool call 封装

两轮均以 tool call 形式调用、schema 显式化，为后续引入内部向量数据库留接缝：
向量库到位后只替换"候选集合怎么来"，provider 调用方式不动。

## 客户端契约边界

服务端向客户端提供：

- 首轮结果新增 `faceAnalysis` / `styleRecommendations` 两段
- 风格选定端点
- `faceMetricsSchema` 放行客户端新增的测算维度（视觉年轻程度、面部性别倾向、颧骨遮盖需求）

客户端不需要知道两轮是否合并、也不需要知道协调判断来自数据还是模型——
后者由 `coordination` 字段如实标注。

## 不做的事

**不做族裔分类。** 分类偏差与合规风险都不低，而它想解决的两件事都有更稳替代：
身份保持交给 SeedEdit 本身（实测胡茬、毛孔、光线均保留）+ negative prompt 兜底；
真正影响推荐的肤色与发质由客户端直接测量提供，无需先给人贴族裔标签。

## Impact

- `steps/analyzeVision.ts` 与 `steps/recommend.ts` 合并
- `services/recommendationApplication.ts`：穿搭入参补人脸信息与已选风格
- `prisma/schema.prisma`：`AppearancePlan` 增加已选风格字段
- 新增风格选定路由
- 决策 2 状态变更为「有意放宽，待数据量」，需在 design.md 记录
