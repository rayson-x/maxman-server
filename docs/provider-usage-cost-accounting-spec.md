# 统一 Provider 用量与成本核算规格

## Problem Statement

BetterMeet 需要在产品定价前，以可信口径掌握供应商的可变成本。现有
`ProviderCallLog` 仅服务于火山异步任务，并只有一个 `costEstimate` 字段；它无法
覆盖可替换的 provider 接口、记录文本模型 token、区分业务调用与轮询/重试，也无法按
供应商和业务目的汇总成本。

项目同时存在 token、成功接受的异步任务、生成图片、请求以及存储/流量等计费单位。
计费规则必须保存在本地，使每次新调用都能按当时规则换算成本，并为未来产品定价提供依据。

## Solution

新增 provider 无关的用量与成本账本。它在业务 provider 接口边界调用：每次外部业务
操作记录标准化用量，并用本地、版本化的价格规则计算估算成本。

规则记录 provider、模型、业务操作、计费维度、币种、单价、生效时间、核对时间和官方
来源。已确认的火山图片换装 `dressing_diffusion` 规则为**每个成功接受的任务 ¥1**；
V1/V2 公开刊例价相同。无法安全确认当前价格的模型仍记录真实用量和调用数，金额为
`unknown`，绝不视为 ¥0。

第一版提供内部、管理员保护的聚合查询，按时间、provider、模型和业务操作汇总调用数、
token、接受任务数、生成图数及估算成本。这是未来定价的运营数据，不是支付、额度或
用户计费系统。

## User Stories

1. As a 产品运营人员, I want 每个外部 provider 的业务调用都留下账本记录, so that 我能了解产品的真实可变成本来源。
2. As a 产品运营人员, I want 输入与输出 token 分开记录, so that token 计费模型能准确核算。
3. As a 产品运营人员, I want 缓存命中与未命中输入 token 在 provider 提供时分开记录, so that 分层 token 单价不会失真。
4. As a 产品运营人员, I want 每张成功生成的图片按图片数计量, so that 按图计费 provider 不会被按请求数误算。
5. As a 产品运营人员, I want 火山图片换装每个成功接受任务只记一次, so that submit 和任意次数 poll 不会重复计入 ¥1 成本。
6. As a 产品运营人员, I want 失败、重试和状态未知调用独立可见, so that 我能分析异常成本风险而不伪造金额。
7. As a 产品运营人员, I want 每条记录保留 provider、模型、业务目的和任务标识, so that 汇总金额可追溯到工作流。
8. As a 产品运营人员, I want 调用绑定当时匹配的费率规则版本, so that 后续调价不会改写历史估算。
9. As a 产品运营人员, I want 本地规则带官方来源和核对时间, so that 每个估算结果可解释、可维护。
10. As a 产品运营人员, I want `dressing_diffusion` 按 ¥1/成功接受任务入表, so that 换装成本按当前确认口径统计。
11. As a 产品运营人员, I want 免费模型也记录用量, so that 后续调价、免费额度或限额可基于真实需求分析。
12. As a 产品运营人员, I want 未确认当前价格的模型明确显示 unknown, so that 总成本报表不会制造虚假完整性。
13. As a provider 实现者, I want 在 provider 业务操作接口注入统一计量 hook, so that 替换任何 provider 时不会绕过核算。
14. As a provider 实现者, I want 保存标准化且脱敏的供应商用量摘要, so that 新费率映射不需要重放私密请求。
15. As a provider 实现者, I want 同步调用只产生一条业务操作记录, so that 接口层核算的含义清晰。
16. As a provider 实现者, I want 异步 submit/poll 共享同一条业务操作记录, so that 崩溃恢复与成本核算有共同身份。
17. As a provider 实现者, I want 重试与传输请求只作为诊断信息, so that 它们不会自动成为额外计费单位。
18. As a 财务或运营分析人员, I want 按时间、provider、模型和操作筛选用量与成本, so that 我能找到主要成本驱动因素。
19. As a 财务或运营分析人员, I want 已知估算金额与 unknown 用量分开返回, so that 缺失规则覆盖率可见。
20. As a 财务或运营分析人员, I want 原始规则币种保留在记录中, so that 聚合不会掩盖汇率假设。
21. As a 隐私敏感用户, I want 成本记录只包含脱敏元数据与用量, so that 照片、prompt 和对话原文不会被复制到财务账本。
22. As a 数据删除流程, I want 既有日志脱敏和删除保障保持有效, so that 新账本不破坏隐私处理。
23. As a 测试工程师, I want 通过 provider 接口验证账本记录和汇总, so that provider 替换或重构后仍能保证核算。
24. As a 后续定价系统实现者, I want 成本核算与额度、限流和支付解耦, so that 能使用成本证据而不改变当前用户访问权。

## Implementation Decisions

- 计量单位是**可计费业务操作**，不是 HTTP 请求。视觉分析、文本规划、推荐、图像编辑、
  换装、天气与对象存储操作都以 provider、模型（如适用）和业务目的标识。
- 主测试与实现接缝是既有 provider 接口操作外的一层统一计量 decorator/hook。provider
  只上报标准化的实际用量；业务编排服务不自行计算价格。既有火山 task ledger 继续作为
  异步恢复身份，并接入而非复制到新账本。
- 标准用量支持组合字段：输入/输出 token、缓存命中/未命中 token、成功接受任务数、
  生成图数、API 请求数、对象请求数、字节与流出字节。不可用维度保持缺失。
- 每条调用记录保存 provider、operation、model、供应商任务/请求标识（若有）、生命周期
  状态、发生时间、用量、匹配规则 ID/版本、计算金额/币种与 `known`/`unknown` 成本状态。
- 本地费率规则必须版本化且可审计，规则选择 provider/model/operation，声明计费维度、
  单价、币种、生效时间、来源 URL、来源范围和核对时间；一次调用确定性匹配一条规则。
- 初始规则覆盖仓库已经接入的所有 provider adapter 与基础设施服务。已确认价格直接录入；
  官方免费模型按零金额但非零用量记录；当前 SKU 价格不明确时金额为 unknown。
- 火山视觉 `dressing_diffusion` 使用 `acceptedTaskCount`，单价 CNY ¥1/任务。仅供应商
  接受提交并返回 task ID 后增加一次；poll 不增加任务数。免费 200 次、账号折扣、资源包、
  税费与控制台议价不从公开刊例价推断。
- 不得把同类或历史模型价格套用到当前 SKU。SeedEdit 3.0、GLM-4.6V、旧 Qwen-VL-Plus
  映射与代码别名 `hunyuan-vision` 在没有对应当前官方 SKU 前保持 unknown。
- 成本是按本地规则计算的估算，而不是供应商账单真值。第一版不自动抓取或静默覆盖官网价格；
  更新规则必须显式并附来源。
- 聚合接受时间范围与 provider/model/operation 可选筛选；已知金额与 unknown 用量分别
  汇总，绝不把 unknown 折算为零。
- 聚合仅供内部管理员使用，不做面向用户的成本看板。
- OSS 作为 provider 在可测量时记录存储、请求和流量；预签名 URL 的签发不作为 OSS 计费
  操作，实际 PUT/GET/DELETE、存储和外网流量才是。PostgreSQL、Redis、BullMQ 与本地
  rule-based materialization 不计入单次 provider 调用成本。
- 保持请求摘要脱敏；新增账本不得记录原始 landmark、照片 URL、原始 prompt 或对话原文。
- 现有重生成容量限流与成本核算保持独立；本变更不新增支付墙、付费额度或访问限制。

## Testing Decisions

- 最高测试接缝是 metered provider-operation boundary：通过 hook 执行代表性 provider
  操作，并断言持久化账本行和汇总结果；不测试 decorator 私有实现。
- 复用现有 task-ledger 与 Prisma round-trip 测试风格。火山异步测试必须证明一次 submit
  加任意 poll 只产生一个 accepted task 单位。
- 覆盖 token、accepted-task、generated-image、免费及 unknown 五类规则。token 测试覆盖
  输入、输出、缓存命中和未命中；缺失供应商 usage 必须保持缺失。
- 覆盖规则不可变性：调用绑定到匹配版本后，新增规则不得改写历史成本。
- 覆盖聚合筛选和汇总，尤其是已知金额与 unknown 用量的分离。
- 通过 provider 接口替换测试验证新增 adapter 无需在编排服务中增加计费代码。
- 用脱敏 fixture 测试隐私/删除行为；不需要真实模型请求或真人照片。
- 保持 HTTP 冒烟测试验证产品流程；成本能力新增窄的内部汇总集成测试，不把 provider
  计费细节塞入 onboarding 冒烟测试。

## Out of Scope

- 面向用户的计费、订阅、支付、发票、退款、余额或权益。
- 用成本阻断用户操作，或改变重生成容量限流。
- 客户端成本仪表盘。
- 自动抓价、自动规则更新或与供应商账单/控制台自动对账。
- 从相似模型、历史通知、资源包或折扣推断缺失价格。
- 回填部署前调用。
- 将 PostgreSQL、Redis、BullMQ 或计算实例固定成本摊到单个用户。
- 仅为计费而替换现有 provider 或生产模型选择。

## Further Notes

- 完整 provider 清单、官方来源和未知价格说明见 `docs/provider-pricing-research-2026-07-29.md`。
- 火山图片换装公开计费页：<https://www.volcengine.com/docs/85128/1462742>。若账号控制台展示
  协议价或资源包折算价，本地规则需要明确采用该报告口径并保留对应来源。
- 既有工作流将部分成功、失败与异步恢复视为一等状态；新核算必须保留这些状态，不能把
  provider 调用压扁为单一“成功”。
