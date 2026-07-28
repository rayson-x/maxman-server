<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

---

# BetterMeet Server

**本仓库独立管理**（自己的 `.git`）。跨端的需求、架构与业务设计在上级 workspace
的 `../AGENTS.md`——先读它再读本文。启动方式、验证脚本、天气数据说明见 `README.md`。

## 权威来源的分工

| 想知道 | 去哪 | 不要去哪 |
|---|---|---|
| 目标业务流程、tool 调用路径、内核/接缝划分、**现状对照表** | `docs/target-workflow.md` | — |
| 数据模型 | `prisma/schema.prisma`（唯一权威） | 任何文档里的字段列表 |
| 某条设计为什么这么定 | `openspec/changes/*/design.md` 与 `changes/archive/*/design.md` | — |
| 当前能力的现行规格 | `openspec/specs/` | 已归档变更的 spec delta |
| 在推进的任务与完成度 | `npm run progress` | tasks.md 的人工计数 |

## 改这里的代码前必须知道的

**设计决策标注了依据强度**：`实测` / `逻辑推演` / `产品决策`。
标「实测」的反直觉写法通常是修 bug 修出来的，不要凭直觉优化掉。几个最容易被误改的：

- **图片生成全局并发上限为 1**，粒度是供应商 `req_key` 而非账号。BullMQ 的
  `concurrency` 是每实例上限、`limiter` 是速率限制，**两者都给不了全局并发保证**。
  真正的闸门是 `src/lib/redisSemaphore.ts`，持槽覆盖整个 submit→poll 生命周期。
- **脸型不在服务端判断。** 云端视觉判脸型实测两家一致率 2/10。服务端只做语义分析，
  prompt 里明确要求不判几何比例。
- **供应商异步调用提交后立刻落盘 `callId`**，断线后凭 callId 恢复轮询而非重新提交
  ——重复提交等于重复计费。
- **部分成功是一等公民。** `completed` 与 `completed_partial` 严格区分，
  缺口逐项写明原因，不假装通过。
- **发际线/发量组合规则的宽严逐档不同**，见 `src/features/appearance-agent/rules/hairConstraints.ts`
  的注释。特别是「仅发量薄不施加任何约束」——短发者会被误判为薄，据此过滤会误伤大量用户。
- **图生图 prompt 的结构约束绑定 provider。** 换模型必须整套重测：SeedEdit 3.0 上
  禁止写发型名，Seedream 4.5 上必须写；构图约束在前者可放句尾，在后者**必须前置**。
  统一拼装在 `src/services/targetImageService.ts` 的 `composeEditInstruction`。

## 两套火山凭证不要混

- **视觉智能**（`VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`）：AK/SK 签名，
  走 `CVSync2AsyncSubmitTask`。SeedEdit 3.0、穿搭换装在这套。
- **方舟 ARK**（`ARK_API_KEY`）：Bearer token，走 `/api/v3/images/generations`。
  Seedream 4.0/4.5/5.0 只在这套，且模型需要在控制台单独开通（否则 404 `ModelNotOpen`）。

## 验证的分工是刻意的

`scripts/smoke-http-flow.sh` 走 HTTP 全链路；`src/scripts/test-e2e-flow.ts` 直接调
step 函数。**后者测不出编排层缺失**——它曾经全绿而 HTTP 链路是断的。
涉及「零件是否装成整机」的验证必须走前者。

出图相关有两个对照台，横轴不同、都要留：
- `npm run calibrate` —— 横轴是 15 款发型，验「这段描述出的是不是这个发型」
- `npm run bench:image` —— 横轴是配置，验「换模型/措辞/分辨率哪个更真」

⚠ 两者每格都产生**真实出图费用**，默认跳过已生成的，`--force` 才重跑。