# Spec：可替换的方案推荐能力

当前实施方案（LLM-first）· 关联 OpenSpec 变更 `add-pluggable-style-recommendation`

本文是推荐能力的技术依据。`target-workflow.md` 与 OpenSpec 与本文保持一致。

---

## 1. 结论与实施原则

当前版本不等待本地风格数据库、匹配规则、风格向量或调研评分。

**先用多模态 LLM/Agent 作为推荐知识的实现，跑通完整业务流程；未来本地数据到位后，
只替换 provider adapter，不修改上游采集、候选展示、用户选择、出图和方案落地链路。**

系统区分两类责任：

| 类型 | 当前实现 |
|---|---|
| 推荐、排序、理由、穿搭建议、主观协调判断 | 可由多模态 LLM/Agent 暂时提供 |
| 同意、权限、幂等、候选归属、费用状态、删除、内容标识 | 必须由代码和数据库保证 |

LLM 输出可以作为当前能力，但必须标明来源和验证等级，不冒充本地数据或调研结论。

### 1.1 客户端测量数据是权威输入，全程可用

缺的是"审美知识"，不是"用户数据"。客户端已经采集并计算出的数据可靠且必须用上：

| 数据 | 来源 | 消费位置 |
|---|---|---|
| 脸型分类 + 置信度 + 支撑比值 | 客户端 478 点几何 | 发型推荐输入；用户确认值优先于计算值 |
| 发际线状态 | 客户端几何（后移判定实测 0/17 假阳性） | 发型推荐输入；代码侧可行性过滤 |
| 发量状态 | 客户端几何 + 问卷自报 | 同上；测量被遮挡时自报补位 |
| 身高体重体脂围度 | 问卷 | 穿搭推荐输入 |
| 眼镜、胡须 | 问卷 | 发型推荐输入；仪容任务 |
| 目标场景、改变意愿、预算、领域选择 | 问卷 | 推荐输入；S5 排序 |

**推荐调用完整接收这些数据**——不给它就无法做出合理推荐。

唯一被限制输入的是"造型客观属性估计"这一次调用，理由见 §5.5。
那是一次关于**造型本身**的判断，与用户数据无关。

## 2. 当前要跑通的主流程

```text
用户提交照片和问卷
→ S1 输入审核
→ S2 照片分析
→ S3 多模态 Agent 给出发型候选、排序和理由
→ 文字候选先返回
→ S4 逐张生成本人模拟图
→ 用户选定发型
→ 多模态 Agent 给出穿搭文字建议
→ 有全身照时生成穿搭模拟图
→ 用户选定穿搭
→ S5 生成阶段化执行方案
```

本地目录为空、风格向量缺失、双审美调研不存在，都不阻断上述流程。

## 3. 稳定模块与可替换 adapter

```text
RecommendationApplication（唯一对外入口）
  ├─ recommendHairstyles
  ├─ recommendOutfits
  ├─ selectCandidate
  ├─ 状态与幂等
  ├─ 照片授权与访问记录
  ├─ Provider 输出校验
  ├─ 安全渲染指令构建
  └─ 可替换 adapter
       ├─ HairstyleRecommendationProvider
       └─ OutfitRecommendationProvider
```

固定管道与未来的对话 tool 都只能调用 `RecommendationApplication`，不直接调用 provider。

provider 的实现可以是：

- 当前：`multimodal-agent`
- 未来：`catalog-matching`
- 未来：`hybrid`（目录过滤 + LLM 排序和解释）

provider 内部可以直接调用多模态模型，也可以由 Agent 通过 tool call 组合视觉分析、
天气、用户画像或其他模型。`RecommendationApplication` 不依赖其内部编排方式。

### 3.1 应用模块 interface

```text
RecommendationApplication
  recommendHairstyles(command) → RecommendationSetView
  recommendOutfits(command)    → RecommendationSetView
  selectCandidate(command)     → SelectionResult
```

首版不要求实现“换一批”、多代级联失效和对话 Agent 入口；这些能力以后在该 interface
上增加，不改变当前三个方法的语义。

## 4. 两种知识模式

### 4.1 当前模式：agent_advisory

本地目录和匹配知识不是前置条件。

多模态 Agent 根据照片、结构化分析、问卷和用户意向直接返回候选。候选保存为本次
`RecommendationSet` 的事实，后续选择和出图都引用 `RecommendationCandidate.id`。

该模式下：

- 不声称“按数据库匹配”
- 不返回未经定义的匹配度或置信分
- 物理可行性可以由 Agent 估计，但标记为 `agent_estimated`
- 穿搭协调可以由 Agent 主观判断，但标记为 `agent_estimated`
- 未执行的校验明确标记为 `not_checked`

### 4.2 未来模式：catalog_constrained

本地目录与验证过的属性到位后：

```text
目录预过滤
→ provider 在 eligibleVariants 内排序
→ 输出后校验
→ 候选引用 CatalogStyleVariant
```

该模式可以标记 `catalog_verified`。切换实现时，上游仍只接收
`RecommendationSetView`，不改变页面、选择、出图或 S5。

## 5. Provider 契约

### 5.1 发型输入

```ts
type HairstyleRecommendationInput = {
  photoReadUrl: string;
  geometry: {
    faceShape: string | null;
    confidence: string | null;
    evidence: Record<string, number>;
  };
  hairSignals: Record<string, unknown>;
  semantics: Record<string, unknown>;
  preference?: {
    text?: string;
    normalizedTag?: string | null;
  };
  changeWillingness?: string | null;
  requestedCount: number;
  catalogVariants?: CatalogVariantView[];
};
```

`catalogVariants` 可选。为空时 `multimodal-agent` 仍必须能够给出建议。

### 5.2 穿搭输入

```ts
type OutfitRecommendationInput = {
  selectedHairstyle: RecommendationCandidateView;
  body?: Record<string, unknown>;
  scene?: Record<string, unknown>;
  weather?: Record<string, unknown>;
  budgetTier?: string | null;
  fullBodyPhotoReadUrl?: string;
  requestedCount: number;
  catalogVariants?: CatalogVariantView[];
};
```

无全身照时不传 `fullBodyPhotoReadUrl`，provider 返回文字建议，后续不触发本人换装生成。

### 5.3 统一候选输出

```ts
type ProviderCandidate = {
  providerCandidateKey: string;
  catalogVariantId?: string;
  nameZh: string;
  description: string;
  modelRationale: string;
  rank: number;
  visualDirection: string;
  estimatedAttributes?: {
    coversForehead?: boolean;
    requiresHairVolume?: "low" | "medium" | "high";
  };
  coordinationAssessment?: {
    status: "agent_estimated" | "catalog_verified" | "not_checked";
    rationale?: string;
  };
};
```

`catalogVariantId` 可选：

- `multimodal-agent` 可以直接输出没有本地目录引用的候选
- `catalog-matching` 返回稳定目录引用
- 两者最终都由应用模块归一化为 `RecommendationCandidate`

provider 不返回最终图生图 prompt。`visualDirection` 是受限的造型描述，应用模块校验后
放入固定模板，并统一追加身份保持、安全边界和禁止修改项。

### 5.4 输出校验

应用模块至少校验：

- 返回数量不超过 `requestedCount`
- `providerCandidateKey` 和候选名称不重复
- `rank` 唯一且连续，从 1 开始
- 必填文本非空并满足长度上限
- 文本通过确定性安全词库
- `visualDirection` 只描述当前领域允许修改的内容
- provider 原始响应不直接传给客户端或图片生成 provider

无本地目录时不执行“必须属于 eligibleVariants”的断言；有目录且 provider 声称返回
`catalogVariantId` 时，必须验证目录归属。

### 5.5 造型属性估计：三件事分开

目录为空时，造型的 `coversForehead` / `requiresHairVolume` 需要估计。
这一步与推荐是**两次不同的调用**：

```text
调用 A  造型属性估计   输入：造型名称与描述（不含用户数据）
                       输出：coversForehead / requiresHairVolume
调用 B  推荐           输入：用户全部数据 + 候选集
                       输出：选哪几个 + 排序 + 理由
代码 C  可行性过滤     输入：A 的属性 + 用户的发量与发际线信号
                       输出：哪些造型对这个用户可行
```

**调用 B 完整接收用户数据。** 只有调用 A 不接收。

理由是一次实测：同一批调用中，模型在得知"用户发际线偏后、约束要求遮额"之后，
把客观上露额的侧分背头与平顶都标注为 `coversForehead: true`；
而在正常发际线场景下，同类的侧分平顶标注为 `false`。
同一类造型在两个场景标注相反，且翻转方向朝着"能通过约束"。

后果是校验显示"保留 3/3、缺口 0"看似完美，实际三条里至少两条客观露额——
用户会拿到会暴露发际线的方向，而系统显示已通过可行性校验。

"背头是否露额"是造型自身的事实，与穿它的人无关。
让估计调用看到用户，只是给了它掰弯答案的动机。

代码 C 才是真正用用户信号做判断的地方，它是确定性的，不会迎合。

**这条限制只在目录为空的阶段存在。** 目录到位后属性直接从目录读，
调用 A 消失，限制随之取消。

## 6. 持久化对象

### 6.1 当前必需

```text
RecommendationSet
  id, planId, kind: hairstyle|outfit
  status: preparing|ready|failed|superseded
  computationKey: string @unique
  inputFingerprint: string
  source: multimodal_agent|catalog_matching|hybrid
  capabilityStatus: Json
  injectedContext: Json?
  createdAt, updatedAt

RecommendationCandidate
  id, setId
  catalogVariantId?          // 当前 Agent 模式允许为空
  providerCandidateKey
  nameZh, description
  modelRationale, rank
  visualDirection
  renderInstruction         // 应用模块构建
  estimatedAttributes: Json?
  verificationStatus: agent_estimated|catalog_verified|not_checked

GeneratedAsset
  id, userId, planId?, candidateId?
  kind: hairstyle_preview|outfit_preview|target_image
  storageKey
  provider, providerCallId?
  disclosure
  createdAt
```

所有生成图片都必须先建立 `GeneratedAsset`，再对用户签发读取 URL。删除单张生成图、
全部生成图、原图级联和账号删除都通过该表枚举 OSS 对象，不能只依赖 job JSON 中的 URL。

### 6.2 未来可选

```text
CatalogStyleVariant
  id, kind, revision, active
  nameZh, aliases, description
  objectiveAttributes
  attributeProvenance
  renderTemplate
```

首版可以不建完整目录，或仅保留少量人工/Agent 生成的参考项。目录不影响
`RecommendationCandidate`、选择和出图的稳定 ID。

## 7. 调用顺序与幂等

```text
① 校验用户、方案、同意状态和照片归属
② 计算 computationKey
③ 原子 insert-or-get RecommendationSet(status=preparing)
     创建成功：本请求成为创建者
     已存在：返回处理中或复用 ready 结果
④ 签发短时照片 URL，并记录授权访问
⑤ 调用当前 provider（首版为 multimodal-agent）
⑥ 校验 provider 输出并构建安全 renderInstruction
⑦ Candidate 写入 + Set 转 ready，同一事务
⑧ 文字结果立即写入 job partialResult
⑨ 图片逐张生成、写 GeneratedAsset、签发读取 URL
```

唯一抢占必须发生在付费调用前。首版可以不实现 refresh，但相同 `computationKey`
不能产生两次 provider 调用。

Provider 调用状态至少记录：

```text
prepared → succeeded | failed | unknown
```

无供应商幂等能力时，状态不确定的调用进入 `unknown`，不自动重复提交。

## 8. 能力状态与用户表述

每个候选集返回：

```ts
type RecommendationCapabilities = {
  knowledgeSource:
    | "multimodal_agent"
    | "catalog_matching"
    | "hybrid";
  feasibility:
    | "agent_estimated"
    | "catalog_verified"
    | "not_checked";
  outfitCoordination:
    | "agent_estimated"
    | "vector_verified"
    | "not_checked";
  previewQuality:
    | "vision_checked"
    | "not_checked";
};
```

表述规则：

| 状态 | 可以说 | 不可以说 |
|---|---|---|
| `multimodal_agent` | AI 根据照片提出的尝试方向 | 根据数据库精确匹配 |
| `agent_estimated` | AI 的主观判断或估计 | 已验证、科学匹配 |
| `catalog_verified` | 已通过当前目录属性规则检查 | 保证现实中一定可实现 |
| `not_checked` | 本项未自动校验 | 省略状态并暗示已经检查 |

不输出没有定义测量对象的 `confidence`、匹配度百分比或双审美数字。

## 9. 缺失能力的 fallback

| 能力 | 首选实现 | 当前 fallback | fallback 失败 |
|---|---|---|---|
| 发型推荐 | catalog-matching | 多模态 Agent 直接推荐 | 本次推荐失败，不编造固定结果 |
| 造型客观属性 | 人工/调研目录 | 独立 Agent 估计（见 §5.5，不接收用户数据） | `not_checked`，不执行硬过滤 |
| 穿搭推荐 | 本地风格数据 | 多模态 Agent 根据上下文给文字建议 | 返回少量通用建议或失败 |
| 发型穿搭协调 | 风格向量规则 | 多模态 Agent 主观判断 | `not_checked` |
| 双审美视角 | 真实调研数据 | Agent 给定性视角描述 | 不返回数字 |
| S5 任务排序 | 已校准规则 | 现有规则或 LLM provider | 固定安全基础任务模板 |
| 排除解释 | 确定性筛选轨迹 | “本轮 Agent 未选择” | 不生成原因 |
| 天气 | 天气 provider | 使用季节/月度摘要 | 忽略天气并标记缺失 |
| 预览质量 | 视觉质量检查 | best-effort 展示 | 标记未自动检查 |
| 内容审核 | 专业审核 provider | 多模态审核 provider | 生产环境 fail closed |
| 主 provider 故障 | 当前多模态模型 | 配置的第二模型 adapter | job 失败或部分成功 |

fallback 的选择由应用模块根据配置和结果状态执行，不允许 provider 自己把失败伪装成
已验证成功。

## 10. 不能使用 LLM fallback 的能力

以下能力必须由确定性代码和持久化状态保证：

- `face_processing` 同意和成年门槛
- 用户、方案、照片和候选归属
- 候选集幂等与并发抢占
- provider 调用状态和费用记录
- 用户实际选择
- 访问授权日志
- 原图与生成图删除
- AI 生成内容显式/隐式标识
- 限流、权限和字段级安全

Agent 的文本不能作为这些能力已经完成的证据。

## 11. 发型与穿搭首版行为

### 11.1 发型

- 多模态 Agent 默认返回 3 个方向
- 每个方向包含名称、描述、理由和 `visualDirection`
- 本地目录存在时可以作为上下文提供，但不是必需
- 文字候选先返回，预览图逐张追加
- 图片全部失败时，文字推荐仍是部分成功

### 11.2 穿搭

- 必须在用户选定发型后调用
- 无风格向量时允许 Agent 主观协调，状态为 `agent_estimated`
- 无全身照时只返回文字建议，不生成或虚构本人穿搭图
- 有全身照时可以追加本人模拟图
- 天气、围度、场景缺失时降级使用已有输入，不阻断整个推荐

## 12. 合规与生成资产

进入真实用户环境前必须满足：

- 上传和分析时检查独立人脸处理同意
- 短时照片 URL 经统一入口签发并记录
- 原图、派生特征、生成图和账号删除可执行
- 所有预览图和目标图通过 `GeneratedAsset` 被删除链路枚举
- API 响应包含 `disclosure`
- PNG 写 tEXt 块，JPEG 写 COM 注释段

第三方模型留存期限、备份删除和供应商侧真实读取审计单独处理，不阻塞本地开发和内部测试。

## 13. 未来替换路径

### 阶段 A：当前

```text
multimodal-agent
→ 直接生成候选、理由、视觉方向
→ catalogVariantId 为空
→ verificationStatus=agent_estimated
```

### 阶段 B：本地目录到位

```text
hybrid
→ 本地目录提供候选和客观属性
→ LLM 负责排序与解释
→ catalogVariantId 有值
→ feasibility=catalog_verified
```

### 阶段 C：匹配数据成熟

```text
catalog-matching
→ 本地规则完成过滤和排序
→ LLM 只负责解释或完全退出
```

三阶段都输出同一个 `RecommendationSetView`，使用同一套 Candidate、GeneratedAsset、
selectCandidate、S4 和 S5 链路。

## 14. 当前实施验收

必须通过：

1. 数据库没有风格目录时，真实或替身多模态 provider 能返回 3 个发型候选
2. 每个候选标记 `source=multimodal_agent`、`verificationStatus=agent_estimated`
3. provider 输出重复 ID、非法 rank、越界文本时被拒绝
4. 同一 `computationKey` 的两个并发请求只调用 provider 一次
5. 文字候选先于图片完成可见
6. 至少一个候选可以生成预览图并建立 `GeneratedAsset`
7. 用户只能选择自己当前 ready 集合中的候选
8. 无全身照时穿搭返回文字结果且零图片生成调用
9. 删除全部生成图和删除账号能够清除预览 OSS 对象
10. 页面/API 不出现数据库匹配、可信度百分比或已经验证的虚假表述
11. 运行一次真实多模态推荐调用，记录实际输出、延迟和不利结论
12. 运行一次真实图片生成，验证 disclosure 与格式对应的隐式标识

## 15. 当前不阻塞实施的事项

- 人工调研的风格目录
- catalog-matching
- 验证过的脸型适配知识
- 风格向量和确定性穿搭协调
- 双审美评分
- 完整筛选审计
- 自动预览质量检查
- RecommendationEvent 校准体系
- 换一批和多代级联失效
- 对话 Agent 生产入口
- 支付、订阅和商业化运营工具

## 16. 开工结论

当前以 `agent_advisory + multimodal-agent provider` 开始实施。

本地风格数据、匹配规则和风格向量均不是前置条件。缺失时由多模态 Agent 输出带来源和
验证状态的临时结论；状态、合规和资产生命周期仍由确定性代码保证。

后续数据能力到位后，通过替换 provider adapter 升级，不改变主业务流程。
