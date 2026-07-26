> 规范文本见 `../../../docs/specs/pluggable-style-recommendation.md`。
> 图例：`[~]` 已知并有意搁置

## 0. 代码库现状（实施前先看这一节）

- [x] 0.1 已有：`providers/styleRecommendation/`（接口 + 多模态实现）、
  `rules/validateRecommendations.ts`（可行性校验，**当前生产零引用，仅测试脚本调用**）、
  `data/objectiveHairstyleAttributes.ts`（17 条造型属性）、
  `steps/recommend.ts`（含指纹与复用逻辑，候选落成 `StyleProfileEntry` 行）
- [x] 0.2 已删除：主链路对抗式复核相关代码（`steps/reviewMainline*`、
  `providers/mainlineReview/`、两个 review service 及其测试）、`ReviewDisagreement` 表
- [x] 0.3 待重构：`steps/recommend.ts` 的候选落库、指纹组成、可行性校验位置都要改，
  不是在其上增量修补
- [x] 0.4 `dist/` 需清理后再跑测试 —— `tsc` 不删除源文件已消失的编译产物
- [x] 0.5 ⚠ 迁移时间戳隐患：既有若干迁移是手写文件夹名且时间戳取在未来（`1800xx`–`1930xx`），而系统时钟落后于它们。`migrate dev` 生成的新迁移会排到它们**之前**，影子库重放时可能出现「先 DROP 后 CREATE」。已修过一次（`drop_review_disagreement` 从 `121719` 改名到 `193500` 并同步 `_prisma_migrations`）。新增迁移后务必跑一次 `migrate dev` 确认影子库能重放

## 1. 数据层

- [x] 1.1 `RecommendationSet` 表 —— `planId`、`kind`、`status`、`computationKey @unique`、
  `inputFingerprint`、`source`、`capabilityStatus` Json、`injectedContext` Json?、
  `generation`（默认 1）
- [x] 1.2 `RecommendationCandidate` 表 —— `setId`、`catalogVariantId?`、
  `providerCandidateKey`、`nameZh`、`description`、`modelRationale`、`rank`、
  `visualDirection`、`renderInstruction`、`estimatedAttributes` Json?、`verificationStatus`
- [x] 1.3 `GeneratedAsset` 表 —— `userId`、`planId?`、`candidateId?`、`kind`、
  `storageKey`、`provider`、`providerCallId?`、`disclosure`
- [x] 1.4 三个枚举：`RecommendationKind`、`RecommendationSetStatus`、`CandidateVerificationStatus`（`VerificationStatus` 已被 `ChangeManifestEntry` 占用）+ `GeneratedAssetKind`；`ProviderCallStatus` 补 `prepared` 与 `unknown`（复用既有账本表，不建第二张）
- [x] 1.5 级联规则：`GeneratedAsset` 随 `User` 级联删除；候选随集合级联；
  集合随方案级联。删除服务必须在删行之前收集 `storageKey`
- [x] 1.6 migration 并应用

## 2. 应用模块骨架

- [x] 2.1 `RecommendationApplication` 三个方法：`recommendHairstyles`、
  `recommendOutfits`、`selectCandidate`
- [x] 2.2 `computationKey` 计算 —— 含 `planId`、`kind`、`generation`、`inputFingerprint`
- [x] 2.3 `inputFingerprint` 组成 —— 该域业务输入 + provider 标识与实现版本 +
  prompt 版本 + 规则版本（目录版本在目录到位后加入）
- [x] 2.4 抢占：唯一键冲突判胜负 + `findUnique` 快速路径。快速路径不是为性能——Prisma 的 log 含 `error`，被 catch 的 P2002 会打成 `prisma:error`，让预期路径看起来像故障。竞态时仍会打一条，属已知噪音
- [x] 2.5 跟随者行为：`preparing` 返回处理中，`ready` 返回结果，均不调用 provider
- [x] 2.6 照片授权：经统一签发入口取短时地址并落访问记录；纯文字穿搭路径不签发
- [x] 2.7 输出校验：数量上限、`providerCandidateKey` 与名称去重、`rank` 唯一连续从 1 起、
  必填文本非空与长度上限、安全词库、`visualDirection` 领域边界
- [x] 2.8 渲染指令构建：固定模板 + `visualDirection`，统一追加身份保持与禁止修改项。
  **模板在应用模块，不依赖目录存在**
- [x] 2.9 候选写入与集合转 `ready` 在同一事务
- [x] 2.10 `capabilityStatus` 组装：知识来源、可行性、穿搭协调、预览质量四个维度
- [x] 2.11 `selectCandidate`：校验候选归属与集合为 `ready`
- [x] 2.12 provider 原始响应不出现在返回给客户端的结构里

## 3. 替身 provider 打通零成本链路

- [x] 3.1 替身发型 provider 与替身穿搭 provider（可注入，计数调用次数）
- [x] 3.2 用替身跑通 `recommendHairstyles` → `selectCandidate` → `recommendOutfits`
- [x] 3.3 断言并发 5 个请求只触发一次调用；并单独断言 `computationKey` 唯一约束在数据库层生效（并发可能走快速路径命中，那样 P2002 分支就没被测到）
- [x] 3.4 断言各类不合格输出被拒（重复标识、rank 不连续、超量、越界描述）

## 3b. 【实施发现】客观属性可直接用现有表，无需 Agent 估计

- [x] 3b.1 `data/objectiveHairstyleAttributes.ts` 已有 17 条人工确认的造型属性（含别名）。
  候选按 `nameZh` 查表命中即为 `catalog_verified`，**零额外调用且完全绕开模型标注污染**。
  spec 原假设「目录为空时只能靠 Agent 估计」，实际不必
- [x] 3b.2 属性解析放在应用模块（`resolveAttributes`），**不采信 provider 自报值**
- [x] 3b.3 未命中表的候选标 `not_checked` 且不编造属性——表覆盖不到的造型，我们确实不知道它露不露额
- [x] 3b.4 集合级 `feasibility` 取最弱档：全部命中才 `catalog_verified`，有一个未命中即 `not_checked`
- [x] 3b.5 断言属性不随用户信号变化：同一候选在「正常发际线」与「后移+薄」两种场景下取到同一个表值
- [~] 3b.6 后续：属性表扩容到覆盖常见造型（当前 17 条，其中 7 条遮额），
  这决定了强约束下可选集合的大小
- [~] 3b.7 未命中名称的独立盲测估计调用 —— 表覆盖足够时不需要；覆盖不足时再评估

## 4. multimodal-agent adapter

- [x] 4.1 发型 adapter —— 输入 `photoReadUrl`、`geometry`、`hairSignals`、`semantics`、
  `preference`、`changeWillingness`、`requestedCount`、`catalogVariants?`
- [x] 4.2 穿搭 adapter —— 输入 `selectedHairstyle`、`body`、`scene`、`weather`、
  `budgetTier`、`fullBodyPhotoReadUrl?`、`requestedCount`、`catalogVariants?`
- [x] 4.3 输出 `ProviderCandidate`：`providerCandidateKey`、`nameZh`、`description`、
  `modelRationale`、`rank`、`visualDirection`、`estimatedAttributes?`、
  `coordinationAssessment?`
- [x] 4.4 `catalogVariants` 为空时仍能给出建议
- [x] 4.5 prompt 要求造型名称使用理发店通用说法
- [x] 4.6 结构化输出用自解析 + zod 校验 —— **实测 glm-4v 把对象包进数组返回**（`[{"candidates":[...]}]`）即使 prompt 给了明确对象示例。解析容忍三种形态：对象 / 单元素数组包对象 / 裸候选数组
- [x] 4.7 **推荐调用完整接收客户端采集与计算出的用户数据** —— 脸型与支撑比值、发际线、发量、身体数据、问卷各项。缺的是审美知识，不是用户数据
- [~] 4.8 **造型属性估计是另一次调用，且不接收用户的发量与发际线信号** —— 它答的是造型自身属性（背头是否露额与穿它的人无关）。实测：模型得知用户发际线偏后后，把客观露额的侧分背头与平顶都标为遮额，而正常发际线场景下同类造型标为露额。这条限制只在目录为空的阶段存在
- [x] 4.9 经环境变量接入容器；缺凭证时构造即抛错

## 4b. 【实测发现】诊断性表述需要代码守卫

- [x] 4b.1 prompt 明确写过「不做医学诊断，不提及疾病或脱发症状」，模型仍产出
  「对于有轻微**脱发**困扰的人来说…」。而 `modelRationale` 直接展示给用户
- [x] 4b.2 在 `validateCandidates` 加诊断性词汇守卫（脱发/秃/症状/诊断/治疗/疾病/病症/病理），
  命中即整条丢弃——一个理由不能展示的候选是不可用的，改写它的文案等于替模型编话
- [x] 4b.3 **刻意不含「发际线」**：那是造型事实而非诊断，「额前碎发能覆盖发际线」
  是正当的造型可行性表述，误杀它会砍掉核心业务语言。已单独断言这一条放行
- [x] 4b.4 真实调用复验 13/13：守卫生效后无诊断性表述，属性表命中 2/3，
  未命中的标 `not_checked` 且未编造属性

## 5. 生成资产与删除链路

- [x] 5.1 `persistGeneratedImage` 之后建 `GeneratedAsset`，再签发读取地址
- [x] 5.2 删除服务的 `all_generated_images` 与 `account` 从 `GeneratedAsset` 枚举
  `storageKey`，覆盖预览图
- [x] 5.3 断言删除全部生成图与删号都能清掉预览图的对象存储对象 —— `test-generated-asset-deletion.ts` 10/10。用不存在的假 storageKey 走真实 OSS（删除不存在对象是幂等空操作，零成本），被测的是「有没有枚举到」

## 6. 付费调用账本

- [x] 6.1 状态 `prepared → succeeded | failed | unknown`
- [x] 6.2 提交供应商前写 `prepared`
- [x] 6.3 过期 `prepared` 转 `unknown`，不自动重提
- [x] 6.4 恢复流程不把 `unknown` 视为待重试
- [x] 6.5 运维说明：所有 `unknown` 需人工对账，无自动恢复

## 7. 接线

- [x] 7.1 `steps/recommend.ts` 改为调用应用模块；旧的 `StyleProfileEntry` 落库路径移除
- [x] 7.2 `renderPreviews` 使用 `renderInstruction`，身份保持后缀由应用模块已追加
- [x] 7.3 `jobOrchestrator` 传入头像 storageKey（由应用模块签发）与身体/场景数据；穿搭改走 `recommendOutfits`，不再按双审美评分从 `StyleProfileEntry` 筛选（那份数据为空会导致零候选卡住 `/materialize`）
- [x] 7.4 文字候选先写 `partialResult`，预览图逐张追加
- [x] 7.5 `select-style` 端点改为调用 `selectCandidate`

### 7b. 接线连带清理

- [x] 7b.1 删除被应用模块取代的旧件：`recommendSafety.test.ts`、`recommendPreference.test.ts`
  （测的是 `generatedStyleCandidateIsSafe` 与 `prioritizeEligiblePreference`，已由
  `validateCandidates` 取代）、`test-render-pipeline.ts`、`test-steps-s1-s3.ts`（走旧管道）。
  副本在本次会话 scratchpad 的 `superseded-by-app-module/`
- [x] 7b.2 `PreviewCandidate` 取代 `ScoredCandidate & { changeInstruction }`——
  预览侧只需要 `candidateId`/`nameZh`/`renderInstruction`（+降级路径用的 `modelRationale`）
- [x] 7b.3 `changeWillingness` 已接上（§8.4 完成）

## 8. 采集项接线

客户端已采集的数据全部可用，本节是把它们接到消费点。


- [x] 8.1 围度四字段接进穿搭输入 `body`（当前零消费点）
- [x] 8.2 `bodyFatPercent`、`exercisesRegularly` 接进穿搭输入
- [x] 8.3 `Event.eventType`/`eventDate` 接住场景意图题（当前服务端只收 `track`，
  `Event` 表零写入）
- [x] 8.4 改变意愿字段接住 satisfaction 页答案，接进发型输入
- [x] 8.5 `occupation` 从 schema、问卷、服务与推荐输入移除

### 6b. 账本实施记录

- [x] 6b.1 `ProviderCallLog` 加 `providerRequestKey`（提交前生成，唯一）、`callId` 改可空 ——
  旧设计以供应商 task_id 为键，而那是提交成功才知道的，崩溃窗口恰好在它之前
- [x] 6b.2 迁移需手写：新增唯一约束会触发 Prisma 的交互确认，`migrate dev` 在非交互环境直接报错。
  手写 SQL 后 `migrate deploy`
- [x] 6b.3 文件版与 PG 版跑同一批断言（`test-provider-call-ledger.ts` 20/20）。
  **这套双实现测试抓到一个真 bug**：PG 版 `getEntry` 只按 `callId` 查，
  而 prepared 行的 `callId` 为空，导致查不到；文件版以 requestKey 为键所以没问题。
  已改为两种键都接
- [x] 6b.4 `prepared` 不进 `listPending` —— 它可能从未真正发出，恢复流程不该轮询它

## 9. 验收（对应 spec §14）

- [x] 9.1 数据库无风格目录时，替身或真实 provider 返回 3 个发型候选
- [x] 9.2 候选标记知识来源为多模态 Agent、验证状态为 Agent 估计
- [x] 9.3 重复标识、非法 rank、越界文本被拒
- [x] 9.4 同一 `computationKey` 的两个并发请求只调用 provider 一次
- [x] 9.5 文字候选先于图片可见
- [x] 9.6 至少一个候选能生成预览图并建立 `GeneratedAsset`
- [x] 9.7 用户只能选择自己当前就绪集合中的候选
- [x] 9.8 无全身照时穿搭返回文字结果且零图片生成调用
- [x] 9.9 删除全部生成图与删号能清除预览对象存储对象
- [x] 9.10 面向用户的结构不出现数据库匹配、可信度百分比或已验证的表述
- [x] 9.11 一次真实多模态调用，记录输出、延迟与不利结论（约 ¥0.03）
- [x] 9.12 隐式标识已验证（`test-generated-image-labels.ts` 9/9）——**零额外费用**：读回冒烟已生成的真实图，不再触发生成调用
- [x] 9.13 属性估计在不同用户发量/发际线信号下结果一致
- [x] 9.14 `tsc` 干净、既有测试全绿（清理 `dist/` 后运行）

### 9b. 冒烟过程中修掉的阻塞项

- [x] 9b.1 **照片审核门槛硬编码在 6 处** —— 审核 provider 搁置导致 `pending` 永不变 `passed`，
  每一处都是硬阻塞；分散修改必然漏，实测连踩两次（「路由放行、编排器说没照片」、
  「编排器放行、S2 说找不到照片」）。收成 `lib/photoModerationGate.ts` 单一判定：
  生产 fail closed、本地接受 pending、**任何环境都不接受 rejected**，三条各有断言
- [x] 9b.2 冒烟脚本更新到新契约：`select-style` 改用 `candidateId`、三个异步入口带
  `Idempotency-Key`、`filterTrace` 断言换成 `capabilityStatus`
- [x] 9b.3 **图片下载被 SSRF 防护拦住** —— 本机 fake-IP 代理把供应商域名映射进
  198.18.0.0/15（IANA 基准测试保留段），被判为私网。加了仅限本地、默认关闭的逃生阀，
  **只放行这一个段**：127.x / 10.x / 172.16-31.x / 192.168.x / 169.254.x 照旧拦截。
  首版实现跳过了整个私网判定，被既有 SSRF 测试当场抓出，已收窄
- [x] 9b.4 S5 的 `selectedStyleTaskService` 改读 `RecommendationCandidate` —— 
  它原先按 `StyleProfileEntry` 查选定项并从双审美评分推 dimensions，
  而选定项现在是候选、且没有评分数据。改为不给 dimensions（诚实地成为 optional，
  core 由方法目录那侧提供）
- [x] 9b.5 隐式标识验证发现**文档与实现不一致**：代码注释与 spec 都写「JPEG APP11」，
  而实现写的是 **COM 注释段（0xFFFE）**。已改文档对齐实现，并注明选 COM 的理由——
  APP11/JUMBF 是 C2PA 来源凭证的载体、需要签名链；当前目标只是可被通用工具读出的生成标记。
  将来要做 C2PA 时升级路径是 APP11 而非扩展 COM

## 10. 当前不阻塞

- [~] 10.1 人工调研的风格目录与 `CatalogStyleVariant` 表
- [~] 10.2 `catalog-matching` 与 `hybrid` 实现
- [~] 10.3 验证过的脸型适配知识、风格向量、确定性穿搭协调
- [~] 10.4 双审美评分与落差披露
- [~] 10.5 完整筛选审计与逐条排除原因
- [~] 10.6 自动预览质量检查
- [~] 10.7 `RecommendationEvent` 校准体系
- [~] 10.8 换一批与多代级联失效
- [~] 10.9 对话 Agent 生产入口
- [~] 10.10 内容安全供应商接入
- [~] 10.11 第三方模型留存期限、备份删除、供应商侧真实读取审计
