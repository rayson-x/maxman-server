# 服务端 Provider 计费调研（2026-07-29）

**目的。** 为即将实现的统一计费 hook 列出服务端所有可配置或已接入的外部
provider，明确每一笔业务调用该记录什么计量单位。本文件只记录当前可从厂商
**官方一手资料**确认的公开价；没有公开、可精确匹配的价格绝不以相近模型代替。
因此 `unknown` 不是免费，而是计费器必须保留用量、次数和 provider/model，暂不
计算金额的状态。

**口径。** 一笔调用应对应厂商实际的付费业务单元，不能把轮询、签名 URL 或 HTTP
重试误记为一次生成。例如火山视觉异步图像任务只在成功提交的生成任务上记一次；
`poll` 只记录诊断请求数，金额为零。除特别说明外，价格为公开刊例价，未扣减免费
额度、资源包、折扣、税费或账单舍入。

## 可直接落入首版本地规则的条目

| Provider / 代码中的模型或操作 | 计费类型与业务计量单位 | 当前公开价 | 计费 hook 应采集 | 官方依据 |
| --- | --- | --- | --- | --- |
| DeepSeek / `deepseek-v4-flash`（输入审核、文本规划、免费推荐、对抗复核、双源复核等） | token；输入缓存命中、输入缓存未命中、输出各自计量 | USD / 1M tokens：cache hit **$0.0028**、cache miss **$0.14**、output **$0.28** | `inputTokens`、`outputTokens`、`cacheHitInputTokens`、`cacheMissInputTokens`；若响应只给 `prompt_tokens`，不能凭空拆分缓存命中 | [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| 火山方舟 / `doubao-seedream-4-5-251128`（默认 `ark` 图像编辑，`images/generations`，代码一次要求一张） | image/request；**每成功生成 1 张图**，图生图与文生图同属该图像模型计量 | **¥0.25 / 张** | `generatedImageCount`（而非 HTTP 请求数）；`size=2K`、模型、是否有参考图作为维度。一次请求若以后返回 N 张，记 N，不是 1 | [火山方舟豆包产品与定价页](https://www.volcengine.com/product/doubao)；[Seedream 4.5 模型/参数文档](https://www.volcengine.com/docs/82379/1541523) |
| 火山视觉 / `dressing_diffusion`（`volcengine-outfit-swap`，图片换装 V1） | request；输入 1 张模特图 + 服装图后**一次成功换装任务** | **¥1 / 次**；V1 与 V2 价格相同，免费试用 200 次，公开并发限额 1 | `submittedTaskCount=1` 仅在提交被厂商接受并得到 task id 后记；`taskId/callId`、`req_key`。submit/poll HTTP 次数另存、不得计价 | [火山视觉「图片换装」产品介绍及计费](https://www.volcengine.com/docs/85128/1462742)；[DressingDiffusion API](https://api.volcengine.com/api-explorer/debug?action=DressingDiffusion&groupName=Visual+Content+Generation+Public+Beta&serviceCode=cv&version=2024-06-06) |
| 阿里云百炼 / `qwen-image-edit-plus`（可选 `qwen` 图像编辑） | image/request；**每输出 1 张图片** | 华北 2（北京）**¥0.20 / 张**；新加坡 ¥0.220177 / 张 | `generatedImageCount`，并保存 region、model snapshot；请求 `n` 的输出张数而非请求次数 | [qwen-image-edit-plus 模型信息与价格](https://help.aliyun.com/zh/model-studio/qwen-image-edit-plus) |
| 阶跃星辰 / `step-image-edit-2`（可选 `stepfun` 图像编辑） | image/request；默认单请求一张 | **¥0.02 / 张** | `generatedImageCount`（当前实现为 1）、模型和返回 id；不可因同步接口没有 task id 而漏记 | [StepFun 定价与限速](https://platform.stepfun.com/docs/zh/guides/pricing/details) |
| 智谱 / `glm-4v-flash`（默认视觉分析及默认 vision-llm 风格推荐） | token usage，但官方将该模型列为**免费模型** | **¥0**（仍应记录 input/output token 与请求数，便于日后调价/配额分析） | `inputTokens`、`outputTokens`、图片数/尺寸和响应 `usage` 原文；不应把图片机械换算为固定 token，除非响应明确给出 | [智谱模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview) |
| 智谱 / `cogview-3-flash`（可选文生图） | image/request | **¥0**（官方列为免费图像生成模型） | `generatedImageCount`、尺寸、响应 id；即使成本为零也保留调用量 | [CogView-3-Flash 模型页](https://docs.bigmodel.cn/cn/guide/models/free/cogview-3-flash)；[智谱模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview) |

## 已接入、但当前不能安全写成固定金额的条目

| Provider / 代码中的模型或操作 | 分类与应计量的单位 | 为什么金额为 `unknown` / 关键 caveat | 官方依据 |
| --- | --- | --- | --- |
| 智谱 / `glm-4.6v`（双源推荐通道；`DUAL_SOURCE_RECOMMENDATION_MODEL` 可覆盖） | token；文本、图片输入和输出 token | 官方模型页确认它是图文模型且明确让用户到「价格界面」查询，但公开模型页未给出可引用的数值。不得用 `glm-4.6v-flash` 的免费规则替代。先落 `usage` 和模型版本，待已登录控制台/正式价格 SKU 确认后补规则。 | [GLM-4.6V 模型页](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v) |
| 火山视觉 / `seededit_v3.0`（可选 `volcengine` 图像编辑） | image/request；**成功提交的一项编辑任务** | 官方 API 确认 req_key 与 submit/get-result 两阶段，但本次未找到该 SKU 的公开价格页；不要把 Seedream 4.5 的 ¥0.25/张套到视觉智能 SeedEdit。先记 `acceptedGenerationTaskCount` 与 `taskId`。 | [SeedEdit 3.0 SubmitTask API](https://api.volcengine.com/api-docs/view?action=SeededitV30SubmitTask&serviceCode=cv&version=2024-06-06) |
| 阿里云百炼 / `qwen-vl-plus`（可选 `qwen` 视觉分析） | token；输入、输出；图片输入也由 provider usage 为准 | 官方 2024-12 通知给出实时调用输入 ¥0.0015/1K、输出 ¥0.0045/1K（即 ¥1.5/¥4.5 每百万 token），但这是一则历史调价通知而非当前 SKU 页。由于当前模型价格表未能在公开内容中确认这个旧模型仍按同价售卖，首版不可把该历史数写成“最新”。 | [Qwen-VL 调价通知](https://help.aliyun.com/zh/model-studio/qwen-vl-model-billing-notice) |
| 腾讯混元 / `hunyuan-vision`（可选视觉分析） | token；输入与输出 | 当前代码 model id 为 `hunyuan-vision`，官方最新计费页列出的是 `Tencent HY Vision 1.5 Instruct`、`hunyuan-turbos-vision`、`hunyuan-t1-vision` 等 SKU（输入 ¥3/1M、输出 ¥9/1M），不能推定 `hunyuan-vision` 等同其中任一 SKU。先记录使用量；部署时按控制台实际 model id 映射规则。 | [腾讯混元生文计费概述](https://cloud.tencent.com/document/product/1729/97731) |
| 腾讯混元 / `hunyuan-outfit-swap` | unknown / not invocable | 代码实现会直接抛出“不支持图像编辑/换装”，所以生产调用数应为零；不是一个可计费服务。若未来接入真实换装 SKU，须重新调研。 | 代码注释引用的[腾讯混元 API 文档入口](https://cloud.tencent.com/document/product/1729)（代码事实：`src/features/appearance-agent/providers/clothing/hunyuanClothingSwap.ts`） |
| Open-Meteo（地理编码、历史天气、预报） | request；分别记录 geocoding/archive/forecast 请求数 | 当前默认 public endpoint 对**非商业用途**免费；本项目是产品，不能把它当可合法长期商用的免费规则。官方要求商业使用订阅，并按套餐而非逐请求公开报价；生产改 customer endpoint 后再把订阅固定成本/调用量分摊写入规则。 | [Open-Meteo 定价与服务条款](https://open-meteo.com/en/pricing)；[API 文档](https://open-meteo.com/en/docs) |
| 阿里云 OSS（上传、生成图回存、读取、删除、预签名 URL） | storage/traffic/request：GB·小时、对象 API 请求、外网流出 GB | 地域、存储冗余/类型、访问路径、资源包决定价格，`.env` 只给 region 不给 bucket 存储类型或流量路径，不能填唯一单价。**预签名 URL 的签发本身不收费**；实际 PUT/GET/DELETE 才按请求计，实际外网下载另计流量，存储按时长计。 | [OSS 计费概述](https://help.aliyun.com/zh/oss/billing-overview)；[OSS 存储费用](https://help.aliyun.com/zh/oss/storage-fees)；[OSS 流量费用](https://help.aliyun.com/zh/oss/traffic-fees) |

## 不应误入第三方调用成本账本的实现

- `rule-based` plan materialization 是本地纯规则，成本为 ¥0；应有业务运行指标，但
  不应生成 provider charge。
- 图片/文本内容审核 provider 尚未选型，代码目前是确定性规则或
  `deferred_no_provider`，没有外部价格可同步。
- PostgreSQL、Redis/BullMQ 只从 `DATABASE_URL`/`REDIS_URL` 获得连接串，没有云厂商
  或实例 SKU；它们是基础设施固定/容量成本，不能伪造为“每次 provider 调用”的可变成本。
- 对外图片 URL 的下载（例如 StepFun 从 OSS 预签名 URL 拉取输入图）会产生相应 OSS
  GET/流出成本，但它属于 OSS 用量，不属于 StepFun 的每张生成价；计费 hook 需避免两边
  重算为同一项。

## 给计费规则与 hook 的最小数据契约

首版至少把每次**业务调用**写成 `provider`、`operation`、`model`、`pricingRuleId`、
`status`、`occurredAt`，再按计费维度任选其一或组合记录：

- token：`inputTokens`、`outputTokens`，以及 provider 给出的 `cachedInputTokens` /
  `uncachedInputTokens`；保存原始 `usage` 摘要以便映射升级。
- image/request：`acceptedTaskCount` 与 `generatedImageCount` 分开。火山换装与
  SeedEdit按前者；Seedream、Qwen、StepFun按后者。轮询请求不能增加前两者。
- storage/traffic：`byteHours`（或对象大小 + 起止时间）、`putRequestCount`、
  `getRequestCount`、`deleteRequestCount`、`egressBytes`。这些必须由 OSS 用量/账单
  对账或可观测性补全，单靠 AI provider 响应得不到。
- `unknown`：仍写真实用量和次数，`cost` 为空而不是 0；这样补上本地价格规则后可回算。

同一规则文件应记录 `currency`、`unit`、`unitPrice`、`effectiveAt`、`checkedAt`、
`sourceUrl` 和 `sourceQuoteScope`（刊例价/历史通知/免费模型），并绑定到调用记录。这样后续
调价不改写历史成本。
