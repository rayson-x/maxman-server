## Context

This documents the `server/src/features/appearance-agent/` module as actually built and empirically tested this session, before any Fastify/Prisma/BullMQ code exists. It is the concrete realization of `add-mvp1-core-flow` design.md decision 16 ("agent + tool composition, not one-shot multimodal integration") plus two capabilities (`TextPlanningProvider` candidate scoring, and a new adversarial-review pattern) that decision only gestured at.

## Directory Structure

```
src/
├── config/env.ts                     # typed env loader, shared across features
├── lib/
│   ├── taskLedger.ts                 # durable async-call ledger (file-backed for now)
│   ├── rateLimiter.ts                # FIFO promise-chain rate limiter
│   └── ossUpload.ts                  # Aliyun OSS upload helper (ali-oss, official SDK)
└── features/appearance-agent/
    ├── composition.ts                # THE composition root — only place that reads
    │                                  # ACTIVE_*_PROVIDER env vars and holds singletons
    ├── agent.ts                      # createAppearanceAgent(deps) factory + full prompt
    ├── data/
    │   └── candidateTaskCatalog.ts   # human-curated seed data (hair + outfit_accessory)
    ├── providers/
    │   ├── vision/                   # VisionAnalysisProvider: zhipu, qwen, hunyuan
    │   ├── imageEdit/                # ImageEditProvider: qwen (默认), volcengine (SeedEdit 3.0), ark (Seedream), stepfun
    │   ├── clothing/                 # ClothingSwapProvider: volcengine (dressing_diffusion), hunyuan (stub, non-viable)
    │   ├── textToImage/              # TextToImageProvider: zhipu (CogView)
    │   ├── textPlanning/             # TextPlanningProvider: deepseek (catalog-constrained scoring)
    │   ├── freeRecommendation/       # FreeRecommendationProvider: deepseek (unconstrained)
    │   ├── adversarialReview/        # AdversarialReviewProvider: deepseek (judge between the two above)
    │   ├── llm/deepseekModel.ts      # the agent's reasoning "brain" model factory
    │   └── volcengine/signedRequest.ts # shared Volcengine SigV4 signing + rate limit + ledger wiring
    └── tools/                        # 7 Mastra tools, one per capability, each a factory
        # createXTool(provider) -> createTool({...}) — takes its dependency
        # as a constructor argument (DI), never imports a global registry
```

## Decisions

### 1. Composition root, not service locator

Every tool factory (`createAnalyzeAppearancePhotoTool(provider)`, etc.) and `createAppearanceAgent(deps)` receive their dependencies as plain constructor arguments. Nothing inside `tools/` or `agent.ts` imports `composition.ts` or reads `process.env`. `composition.ts` is the **only** file that:
- reads `ACTIVE_*_PROVIDER` env vars to pick a concrete vendor implementation (design.md decision 16 of `add-mvp1-core-flow`: vendor selection is a runtime config choice),
- caches singleton instances (`??=` lazy init),
- assembles the `AppearanceAgentDeps` object and calls `createAppearanceAgent(deps)`.

This is deliberately Fastify-agnostic (no `fastify.decorate()` yet, since no Fastify app exists in this change's scope) but is structured so the future Fastify composition root can either import this module's `getAppearanceAgent()` directly, or re-implement the same DI wiring using `fastify.decorate()` if per-request scoping is later needed (e.g. per-tenant provider overrides) — nothing in `tools/`/`agent.ts` would need to change either way.

### 2. Provider taxonomy and empirically confirmed vendor status

| Capability | Vendor | Status | Notes |
|---|---|---|---|
| `VisionAnalysisProvider` | Zhipu GLM-4V-Flash | ✅ working | default |
| | Qwen-VL-Plus (DashScope) | ✅ working | required per-model console enablement, separate from chat models |
| | Hunyuan-vision | ❌ blocked | API key invalid, needs regeneration |
| `ImageEditProvider` (img2img) | Seedream 4.5（方舟 ARK，`doubao-seedream-4-5-251128`） | ✅ working | **default**（第三次调整：volcengine → qwen → ark）。发丝质感、皮肤/背景保真度全场最好，且两款测试都保持正脸构图。付出的代价见下方「图像编辑 provider 的默认选择」 |
| | Qwen-Image-Edit-Plus (DashScope) | ✅ working | 曾是 default。比 SeedEdit 好，但三七侧分这类需要清楚分缝的款式结构偏软 |
| | Volcengine SeedEdit 3.0 (`seededit_v3.0`) | ✅ working | 最初的 default。**「identity preservation 强」这条结论已被推翻**——它重画整幅画面（磨皮、削脸、背景漂移），且输出被钳在短边 864 |
| | Seedream 4.0（方舟 ARK） | ✅ working，不推荐 | 比 SeedEdit 基准还差（墙面漂移 18-22 vs 基准 5.3-6.0） |
| | Seedream 5.0 lite（方舟 ARK） | ✅ working，不推荐 | 质感全场最好，但会自作主张把正脸转成侧脸构图——身份/构图保持不可控，且延迟约 4.5 档的 2 倍 |
| | ~~Qwen wanx2.1-imageedit~~ | 已弃 | 旧的 async wanx 接口，从未跑通过（`Model.AccessDenied`）。现已改走 multimodal-generation |
| `ClothingSwapProvider` | Volcengine `dressing_diffusion` (V1) | ✅ working | confirmed end-to-end with synthetic model+garment photos via `CVSync2AsyncSubmitTask`/`GetResult` |
| | Volcengine `dressing_diffusionV2` (multi-garment) | not attempted | documented under a different Action pair (`CVSubmitTask`/`CVGetResult`, not `Sync2Async`) — unverified, not needed yet |
| | Hunyuan | ❌ not viable | official SDK inspected — no image-input capability exists at all, this is a capability gap not a credentials gap |
| `TextToImageProvider` | Zhipu CogView (`cogview-3-flash`) | ✅ working | sync call, `{baseURL}/images/generations`, OpenAI images-API shape |
| `TextPlanningProvider` / `FreeRecommendationProvider` / `AdversarialReviewProvider` | DeepSeek (`deepseek-v4-flash`) via `generateObject` | ✅ working | see decision 4 below for the prompting gotchas required to get reliable structured output |

Aliyun DashScope's `access_denied` (blocking Qwen vision + Qwen img2img) was resolved for vision mid-session by the user enabling `qwen-vl-plus` specifically in the console; **img2img's `wanx2.1-imageedit` is a separate model requiring its own console enablement** — this was not yet done as of this change.

#### 图像编辑 provider 的默认选择（后续修订）

这张表最初把 SeedEdit 3.0 记为「identity preservation 强」。那个结论是在**合成证件照**上得出的，
源图本来就是短发贴头、改动量小，所以看不出问题。换成真人照（长发、室内侧光）后，1:1 裁切下问题一眼可见，
并且可量化——取「剪头发不该动到」的左上墙面算与原图的 RMSE，把降采样再放回的重采样误差 0.22 当地板：

| 配置 | 墙面 RMSE | 输出尺寸 |
|---|---|---|
| 重采样地板（控制组） | 0.22 | — |
| SeedEdit 3.0 | 5.3–6.0（地板 24×） | 1152×864 |
| SeedEdit + 质感措辞 | 5.7–6.0 | 1152×864 |
| SeedEdit + 短边 1536 输入 | 5.3 | **仍是 1152×864** |
| Qwen-Image-Edit-Plus | 1.3–1.4（地板 6×） | 1184×896 |

三条结论：

1. **主因是 provider，不是 prompt 措辞。** 我们的 prompt 里没有任何一句要求修皮肤或瘦脸，
   但 SeedEdit 把原图额头痘印、毛孔全磨掉，某些款还把脸削窄了——它在重新合成整幅画面。
2. **喂高分辨率是死路。** 源图放大到短边 1536 再喂，输出仍被钳在 1152×864；
   发丝细节是在模型内部被降采样吃掉的，调用方无法干预。SeedEdit 没有 `size` 参数。
3. **加质感措辞只有小幅收益。** 正向加「发丝根根分明」确实让发梢多出分股，
   但偏毛躁，且对墙面漂移毫无改善。是微调，不是解法。

因此默认先改为 `qwen`。**代价要记清**：三七侧分这类需要清楚分缝的款式，Qwen 的结构不如 SeedEdit 准
（它偏软、分缝不明确），而 `objectiveHairstyleAttributes.renderDescription` 那 15 段措辞是**按 SeedEdit 校准的**，
换 provider 后需要按 Qwen 重校一轮。两家都还在磨脸部皮肤——彻底解决要靠头发区域外贴回原图像素，尚未做。

#### 补一轮：方舟 Seedream 三档

拿到 `ARK_API_KEY` 后把 Seedream 4.0/4.5/5.0 lite 三档也接进同一张对照台，跟已有的 A（SeedEdit）、D（Qwen）横向对比：

| 配置 | 墙面 RMSE | 输出尺寸 | 结构准确度 |
|---|---|---|---|
| Seedream 4.0 | 18.65 / 22.06（比 A 还差） | 2304×1728 | — |
| Seedream 4.5 | 4.33 / 2.81 | 2304×1728 | 两款均正脸，结构合理 |
| Seedream 5.0 lite | 3.43 / 3.64 | 2304×1728 | **三七侧分那款把正脸转成了侧脸构图** |

注意 5.0 lite 在「三七侧分」上「下三分之一 RMSE」高达 30（全场最高），肉眼核实后确认不是噪声——
是模型自己把头部转了角度、重新摆了姿势，构图保持能力比数字暗示得更不可控。4.0 档在两款测试里
都明显劣于 SeedEdit 基准，直接排除。4.5 档发丝质感、皮肤/背景保真度全场最好，且两款测试都保持
正脸构图，价格 $0.04/张（约 ¥0.29，与 SeedEdit 同量级）。

默认改为 `ark`（`doubao-seedream-4-5-251128`）。方舟是三套凭证里最新接入的一套（`ARK_API_KEY`，
与视觉智能的 AK/SK 是分开的两套认证），只验证过生产码路（OSS 预签名 URL）能通，尚未在真实生产
流量下跑过。15 款 `renderDescription` 仍是按 SeedEdit 校准的旧措辞，换 provider 后仍需重校一轮——
这条债务经过两次 provider 切换后还没还。

对照台：`src/scripts/bench-image-edit.ts`（`npm run bench:image`），横轴是配置、纵轴是发型；
与 `calibrate-hairstyles.ts`（横轴 15 款发型、验描述对不对版）分工不同，两个都要留。

### 3. Volcengine-specific infrastructure: rate limiting + durable task ledger

Most Volcengine Visual/CV OpenAPI endpoints cap out at 2 QPS and hard-reject faster calls — this applies across submit AND poll calls against the same service, including concurrent polling loops for different tasks. `src/lib/rateLimiter.ts` provides a FIFO promise-chain limiter (lock-free — no mutex/semaphore, just chained promises on the event loop) wrapped around every call in `signedRequest.ts`'s `callVolcVisualAPI`, defaulting to a 600ms minimum interval between call starts (~1.67 QPS, safety margin under the 2 QPS cap), configurable via `VOLC_MIN_CALL_INTERVAL_MS`.

This in-process limiter is correct for the current single-process script/agent stage but does NOT coordinate across multiple processes. Once `add-mvp1-core-flow`'s `image-generation` BullMQ queue exists with multiple worker processes, the per-queue `limiter: {max, duration}` option (Redis-backed, so it correctly coordinates across all workers) should replace this in-process limiter for the Volcengine-bound work specifically — a fixed, bounded worker pool consuming that queue is what actually keeps total request rate under the vendor's cap in a multi-process deployment.

`src/lib/taskLedger.ts` durably records every Volcengine async call under its `task_id` (=`callId`): `recordSubmitted` (before the caller even starts polling), `recordProgress`/`recordResult` (as poll status changes), and `resumeVolcVisualTask(callId)` (resume polling from just a callId, reading the `reqKey` back out of the ledger — so a crashed/disconnected caller doesn't resubmit and get billed twice). This is currently a JSON file (`data/task-ledger.json`) since no Prisma DB exists yet in this change's scope; when `add-mvp1-core-flow` builds the real schema, this should become a `ProviderCallLog` Postgres table with the same external interface, so provider code doesn't need to change — only the storage backend swaps.

### 4. Structured LLM output requires explicit JSON templates, not just a zod schema

`generateObject` (Vercel AI SDK) against DeepSeek's OpenAI-compatible endpoint uses `response_format: json_object`, which has two gotchas discovered empirically:
- DeepSeek's API hard-rejects the call unless the literal word "json" appears somewhere in the prompt text (not enforced by the SDK — a DeepSeek-side API validation).
- `response_format: json_object` does NOT grammar-constrain the output to the zod schema shape the way native tool-calling/structured-output modes do — the model free-styles field names and nesting unless the prompt spells out an exact key-by-key example. (Empirically: without an example, the model invented `method_id` instead of `catalogEntryId` and nested `{score, reason}` objects instead of flat numbers, even though the zod schema was passed to `generateObject`.)

The fix applied in all three `textPlanning`/`freeRecommendation`/`adversarialReview` providers: every prompt ends with a concrete filled-in JSON example showing the exact key names and flat types expected, plus a defense-in-depth filter in code that drops any returned `catalogEntryId` not present in the original candidate set (in case the model hallucinates an id anyway).

### 5. CandidateTaskCatalog: human-curated, isRecommended filter applied before the model ever sees it

Per `add-mvp1-core-flow` design.md decision 15, `TextPlanningProvider` must never invent methods outside a human-curated catalog. `data/candidateTaskCatalog.ts` seeds a starter catalog (hair + outfit_accessory domains only, ~9 entries) matching the `CandidateTaskCatalog` Prisma model fields from `prisma/schema.prisma` §4.1 (domain, method_name→methodName, evidence_basis→evidenceBasis, is_recommended→isRecommended, exclusion_reason→exclusionReason, etc. — camelCase in code, snake_case in the eventual DB column names). `getRecommendedCatalogEntries(domain)` filters to `isRecommended=true` **before** any candidate ever reaches the LLM prompt — this is stronger than instructing the model not to select excluded entries; excluded entries (e.g. `hair-05`, "下颌线训练器", mirroring the exact example called out in design.md decision 15) are structurally invisible to the model, not just discouraged.

The full 26-method / 8-domain catalog (`add-mvp1-core-flow` tasks.md 7.5a) is separate content-authoring work, not required to validate this mechanism.

### 6. TextPlanningProvider outputs raw dimension scores only — never a final ranking

Matching `add-mvp1-core-flow` design.md decision 6 exactly: `TextPlanningProvider.scoreCandidates()` returns per-candidate raw 0-10 scores across 7 dimensions (visualBenefit, credibility, acceptance, reversibility, timeCost, moneyCost, risk) plus a rationale string — it does NOT compute a final priority/rank. The agent's instructions explicitly forbid it from applying the weighted formula itself ("那是后端固定公式的职责") — that remains `add-mvp1-core-flow` tasks.md 7.6's job once the Fastify service layer exists. Today there is no consumer of these scores other than the agent's own explanatory text to the user; wiring the actual fixed-weight formula is out of this change's scope.

### 7. Adversarial review: constrained vs. free, judged by a third call

New pattern not previously specified anywhere: alongside the catalog-constrained `recommend-appearance-directions` tool, two more tools let the agent get a second, unconstrained opinion and reconcile it:

```
recommend-appearance-directions       (TextPlanningProvider, catalog-constrained)
        │
suggest-unconstrained-directions      (FreeRecommendationProvider, no catalog — model can propose anything)
        │
        ▼
adversarial-review-recommendations    (AdversarialReviewProvider — takes BOTH outputs)
        │
        ├─ per free-suggestion verdict: accept | reject | needs_professional_review
        ├─ duplicatesCatalogEntry: bool (is this free suggestion the same idea as a catalog entry?)
        ├─ feasibilityScore (0-10): how realistically achievable, given cost/time/risk
        └─ improvementRateScore (0-10, "提升率"): expected magnitude of visible improvement if accepted suggestions are followed
```

The judge's default posture toward free suggestions is skeptical-until-justified (explicit in the prompt: reject unless it survives scrutiny on evidence/safety/incremental value over the catalog). The agent's instructions hard-require this sequencing: `suggest-unconstrained-directions`'s raw output must never be shown to the user directly — only `adversarial-review-recommendations`'s `accept`-verdict items may be presented, `reject` items must be disclosed as rejected with reason, and `needs_professional_review` items must be redirected to professional consultation language (echoing `add-mvp1-core-flow` design.md decision 7's "建议这样做更好" tone requirement for unverified claims).

This was validated end-to-end: given a synthetic user profile, the agent correctly called all three tools in sequence and synthesized a final answer that clearly distinguished catalog-backed baseline suggestions from adversarially-vetted free suggestions, never surfacing unvetted content.

## Full Agent Prompt (as implemented)

```
你是一个形象改善助手的推理引擎。你自己看不到图片，需要的时候调用 analyze-appearance-photo 工具获取照片的结构化描述。
生成发型/仪容变化效果图时调用 edit-appearance-image 工具，且必须传入用户最初上传的原始基准照片URL，不能用之前生成过的图片作为输入。
生成换装效果图时调用 swap-outfit 工具。
如果只是需要展示一个风格/发型/服装概念的示意图（不基于用户本人照片，不是个性化效果图），才调用 generate-reference-image 工具，
并且必须明确告知用户这只是风格示意图、不是他本人的效果图。
如果需要分析用户在发型(hair)或穿搭(outfit_accessory)方向上适合/可以发展的具体方法，调用 recommend-appearance-directions 工具——
这个工具只会从人工审核过的方法目录里返回候选项和各维度评分，你不能自己凭空发明目录之外的改造方法，也不要自己把这些评分加权排出最终优先级，
那是后端固定公式的职责，你只负责基于这些评分和理由生成给用户看的解释文案。
如果用户明确要求更大胆/更全面的建议（不只是目录内的保守方案），调用 suggest-unconstrained-directions 获取不受限制的建议，
但这些建议未经验证，绝对不能直接展示给用户——必须紧接着调用 adversarial-review-recommendations，把这两组结果一起传进去做对抗式审查，
只有 verdict=accept 的自由建议才可以呈现给用户，reject 的要说明被否决的原因，needs_professional_review 的要建议用户咨询专业人士。
不要评判性描述用户外貌，不要做医学诊断。
```

Model: DeepSeek (`deepseek-v4-flash`), chosen purely for reasoning/tool-calling quality — no multimodal requirement (`add-mvp1-core-flow` design.md decision 16).

## Tool Inventory (I/O contracts)

| # | Tool id | Input | Output | Provider capability |
|---|---|---|---|---|
| 1 | `analyze-appearance-photo` | `imageUrl`, `focus` | `{provider, analysis}` (free-text/JSON description) | `VisionAnalysisProvider` |
| 2 | `edit-appearance-image` | `baselineImageUrl`, `instruction` | `{provider, imageUrl, imageBase64, callId}` | `ImageEditProvider` |
| 3 | `swap-outfit` | `personImageUrl`, `garmentImageUrl` | `{provider, imageUrl, imageBase64, callId}` | `ClothingSwapProvider` |
| 4 | `generate-reference-image` | `prompt`, `size?` | `{provider, imageUrl, imageBase64}` | `TextToImageProvider` |
| 5 | `recommend-appearance-directions` | `analysisSummary`, `domain` | `{provider, candidates: (score+methodName+description)[]}` | `TextPlanningProvider` + `CandidateTaskCatalog` |
| 6 | `suggest-unconstrained-directions` | `analysisSummary`, `domain` | `{provider, suggestions: FreeSuggestion[]}` (UNVETTED) | `FreeRecommendationProvider` |
| 7 | `adversarial-review-recommendations` | `analysisSummary`, `domain`, `constrained[]`, `free[]` | `{provider, feasibilityScore, improvementRateScore, freeSuggestionVerdicts[], summary}` | `AdversarialReviewProvider` |

## Relationship to `add-mvp1-core-flow`

This change's output — `getAppearanceAgent()` from `composition.ts` — is what the future Fastify `workflows/` layer (per `add-mvp1-core-flow` tasks.md section 7, "Appearance Analysis Orchestration") will call inside the Mastra workflow steps described in `prisma/schema.prisma` §7.1:
- Step 2 (视觉结构化分析) ↔ tool 1
- Step 4 (并行方案分支, 发型/穿搭) ↔ tools 5/6/7 (this change covers hair + outfit_accessory only; skincare/fitness domains are not yet built)
- Step 7 (目标图生成) ↔ tools 2/3

Steps 1/3/5/6/8/9/10 (input/output moderation, profile merge, fixed-weight scoring, quality-check, publish) remain entirely unbuilt — they are pure business logic or separate provider categories (`ImageModerationProvider`, `TextModerationProvider`) not in this change's scope.

## Open Questions Carried Forward

- Qwen `wanx2.1-imageedit` needs its own DashScope console model enablement (separate from `qwen-vl-plus`) before it can be used as a second `ImageEditProvider` option.
- Tencent Hunyuan LLM API key is invalid; needs regeneration at the Hunyuan console. Even once fixed, Hunyuan remains non-viable for `ClothingSwapProvider` (no image-input capability exists in the official SDK).
- `add-mvp1-core-flow`'s "Open Questions" section (model provider selection) should be updated to reflect the empirical findings in decision 2's table above — tracked as a task in this change.
- Domains beyond hair/outfit_accessory (skincare, fitness, body odor, dental, posture, other) have no `CandidateTaskCatalog` entries or tool coverage yet.
