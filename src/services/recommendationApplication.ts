import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type {
  RecommendationKind,
  CandidateVerificationStatus,
} from "../generated/prisma/enums.js";
import { createPhotoAccessService } from "./photoAccessService.js";
import { identityConstraint } from "./targetImageService.js";
import { reviewFreeInput } from "../features/appearance-agent/data/domainLexicon.js";
import {
  OBJECTIVE_HAIRSTYLE_ATTRIBUTES,
  findObjectiveHairstyleAttributes,
} from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";
import { computeHairConstraint, applyHairConstraint, type HairSignals } from "../features/appearance-agent/rules/hairConstraints.js";
import { applySemanticHairlineVisibility, type StructuredSemanticAnalysis } from "../features/appearance-agent/analysis/semanticAnalysis.js";
import { recordWorkflowRun } from "../steps/types.js";
import { recommendWardrobe } from "../features/wardrobe-recommendation/recommend.js";
import type { RecommendWardrobeRequest, WardrobeProfile } from "../features/wardrobe-recommendation/types.js";

/**
 * 推荐能力的唯一对外入口。
 *
 * 为什么是应用模块而不是"共享同一个 provider"：只共享 provider 不足以防止行为分叉——
 * 固定管道与将来的对话 tool 仍可各自实现抢占、幂等、照片授权、输出校验、候选落库。
 * 把这些收进来，两个入口才会给出同一个结论。
 *
 * 三件事由这里持有、不随 provider 实现变化：
 *   1. **抢占先于付费调用**（见 `acquireSet`）
 *   2. **输出校验与渲染指令构建**（见 `validateCandidates` / `buildRenderInstruction`）
 *   3. 照片授权与访问记录
 */

/**
 * 送给 provider 的硬约束上下文。
 *
 * `feasibleNames` 是属性表按约束筛过的**可行子集**，不是完整词表。
 * provider 只做建议，权威判定始终是应用模块调用后的 `applyHairConstraint`；
 * 前置告知只是让模型别把机会浪费在注定被剔除的候选上。
 */
export type HairConstraintContext = {
  requireCoversForehead: boolean;
  excludeVolumeRequirements: ("low" | "medium" | "high")[];
  rationale: string;
  feasibleNames: string[];
};

/** 属性表里满足约束的造型名。约束为空时返回全表。 */
export function feasibleHairstyleNames(constraint: {
  requireCoversForehead: boolean;
  excludeVolumeRequirements: ("low" | "medium" | "high")[];
}): string[] {
  return OBJECTIVE_HAIRSTYLE_ATTRIBUTES.filter(
    (a) =>
      !constraint.excludeVolumeRequirements.includes(a.requiresHairVolume)
      && (!constraint.requireCoversForehead || a.coversForehead),
  ).map((a) => a.canonicalName);
}

export type RecommendationSourceName = "multimodal_agent" | "catalog_matching" | "hybrid";

export type CapabilityStatus = {
  knowledgeSource: RecommendationSourceName;
  feasibility: "agent_estimated" | "catalog_verified" | "not_checked";
  outfitCoordination: "agent_estimated" | "vector_verified" | "not_checked";
  previewQuality: "vision_checked" | "not_checked";
};

/** provider 返回的候选。**不含**最终图生图指令与客观属性的权威值 */
export type ProviderCandidate = {
  providerCandidateKey: string;
  catalogVariantId?: string;
  nameZh: string;
  description: string;
  modelRationale: string;
  rank: number;
  /** 受限造型描述。应用模块校验后放入固定模板，provider 不产出完整 prompt */
  visualDirection: string;
  /** 首轮发型候选所属的风格方向；穿搭候选不填。 */
  styleDirectionId?: string;
  estimatedAttributes?: {
    coversForehead?: boolean;
    requiresHairVolume?: "low" | "medium" | "high";
  };
  coordinationAssessment?: {
    status: "agent_estimated" | "catalog_verified" | "not_checked";
    rationale?: string;
  };
};

export type CandidateView = {
  candidateId: string;
  nameZh: string;
  description: string;
  modelRationale: string;
  rank: number;
  /** 已含身份保持后缀，出图侧直接用，不要再拼 */
  renderInstruction: string;
  verificationStatus: CandidateVerificationStatus;
  estimatedAttributes: ProviderCandidate["estimatedAttributes"] | null;
  /** 供客户端把发型候选展示在对应风格方向下。 */
  styleDirectionId: string | null;
};

/** 首轮同一次多模态调用的附加输出，供风格选择与穿搭上下文复用。 */
export type FirstRoundAgentOutput = {
  faceAnalysis: {
    narrative: string;
    structuredSemantic: StructuredSemanticAnalysis;
  };
  styleRecommendations: Array<{
    id: string;
    nameZh: string;
    description: string;
    rationale: string;
  }>;
};

export type RecommendationSetView = {
  setId: string;
  kind: RecommendationKind;
  status: "preparing" | "ready" | "failed" | "superseded";
  generation: number;
  capabilityStatus: CapabilityStatus;
  candidates: CandidateView[];
  /** 跟随者读到 preparing 时为 true，调用方应轮询而非重试 */
  inProgress: boolean;
  reused: boolean;
  firstRound?: FirstRoundAgentOutput;
  /** 仅由应用层写入的结构化失败摘要；不含模型原始文本。 */
  failureReason?: string | null;
};

export type SelectionResult =
  | { ok: true; candidateId: string; nameZh: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_owned"
        | "set_not_ready"
        | "style_not_selected"
        | "style_not_offered"
        | "candidate_not_in_selected_style";
    };

/** 候选文本的长度上限。超长的多半是模型把整段说明塞进了字段 */
const LIMITS = { nameZh: 40, description: 300, modelRationale: 400, visualDirection: 300 } as const;

/**
 * `preparing` 超过这个时长即视为遗留（worker 被杀、进程崩溃），可被回收重跑。
 * 取值要大于一次推荐加出图的正常耗时，否则会把还在跑的集合抢走。
 */
const STALE_PREPARING_MS = 10 * 60 * 1000;

/**
 * follower 等创建者的上限与轮询间隔。上限要盖住一次推荐调用的正常耗时
 * （实测多模态推荐 6-11s），又不能长到把 HTTP 请求挂死。
 */
const FOLLOWER_WAIT_MS = 45 * 1000;
const FOLLOWER_POLL_MS = 500;

/**
 * `visualDirection` 允许描述的范围。
 * 越界的例子：改变脸型骨骼、性别、年龄、背景、体型——这些由固定模板统一禁止，
 * 若 provider 又在描述里要求，两边会冲突。
 */
/**
 * 守卫前先归一化，否则空格/全角/繁体就能绕过。
 * 用户可控文本（`stylePreferenceText`，300 字）会经 prompt 进入模型输出，
 * 再经 `visualDirection` 拼进图生图指令——绕过守卫等于拿用户真实人脸
 * 生成越界图像，且已带上身份保持后缀。
 */
function normalizeForGuard(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // 需要拦的词的常见繁体写法（不做完整繁简转换，只覆盖守卫词表用到的字）
    .replace(/臉/g, "脸").replace(/骼/g, "骼").replace(/頜/g, "颌").replace(/顎/g, "颌")
    .replace(/顴/g, "颧").replace(/鼻樑/g, "鼻梁").replace(/嘴脣/g, "嘴唇")
    .replace(/種族/g, "种族").replace(/膚色/g, "肤色").replace(/裸體/g, "裸体")
    .replace(/髮際線/g, "发际线").replace(/脫髮/g, "脱发").replace(/髮/g, "发")
    .replace(/兒童/g, "儿童").replace(/減脂/g, "减脂").replace(/瘦身/g, "瘦身");
}

const OUT_OF_DOMAIN_DIRECTION = /(脸型|骨骼|下颌|颧骨|鼻|眼睛|嘴唇|性别|年龄|种族|背景|身高|减脂|增肌|瘦身|变胖)/;

/**
 * 面向用户的文案里禁止出现的**诊断性表述**。
 *
 * 实测必要性：prompt 明确写过「不做医学诊断，不提及疾病或脱发症状」，
 * 模型仍然产出「对于有轻微脱发困扰的人来说…」。而 `modelRationale` 是直接展示给
 * 用户看的，所以这一条必须由代码守卫，不能只靠 prompt。
 *
 * ⚠ 刻意不含「发际线」：那是造型事实而非诊断，
 * 「额前碎发能覆盖发际线」是正当的造型可行性表述，误杀它会砍掉核心业务语言。
 */
/**
 * 与人物图像生成绑死的红线：命中即整条丢弃，不看它落在哪个字段。
 * 首版的越界词表只覆盖「改脸型体型」这类跑偏，完全没有裸露/情色/未成年化项——
 * 而这条链路的终点是拿用户本人的脸做图生图。
 */
const ALWAYS_REJECTED_DIRECTION =
  /(裸体|裸露|全裸|半裸|情色|色情|性感撩人|内衣|内裤|比基尼|泳装|脱衣|露点|儿童|小孩|幼|未成年|低龄化|校服)/;

const DIAGNOSTIC_TERMS = /(脱发|秃|症状|诊断|治疗|疾病|病症|病理)/;

function stableHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v).sort().reduce<Record<string, unknown>>((acc, k) => ((acc[k] = (v as Record<string, unknown>)[k]), acc), {})
      : v,
  );
  return createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 32);
}

export type RecommendationApplicationDeps = {
  prisma: PrismaClient;
  /** provider 标识与实现版本进指纹：切换实现后旧候选集不被复用 */
  hairstyleProvider: {
    readonly name: string;
    readonly version: string;
    readonly source: RecommendationSourceName;
    recommend(input: unknown): Promise<{
      candidates: ProviderCandidate[];
      callId?: string;
      latencyMs?: number;
      provider?: string;
      modelVersion?: string;
      firstRound?: FirstRoundAgentOutput;
    }>;
  };
  outfitProvider: {
    readonly name: string;
    readonly version: string;
    readonly source: RecommendationSourceName;
    recommend(input: unknown): Promise<{
      candidates: ProviderCandidate[];
      callId?: string;
      latencyMs?: number;
      provider?: string;
      modelVersion?: string;
      firstRound?: FirstRoundAgentOutput;
    }>;
  };
};

function isFirstRoundOutput(value: unknown): value is FirstRoundAgentOutput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FirstRoundAgentOutput>;
  return (
    Boolean(candidate.faceAnalysis)
    && typeof candidate.faceAnalysis?.narrative === "string"
    && Array.isArray(candidate.styleRecommendations)
  );
}

/** 从已完成首轮的持久化结果中重新取回风格，不能相信请求体带来的整段对象。 */
function findPersistedStyleDirection(
  partialResult: unknown,
  styleId: string,
): FirstRoundAgentOutput["styleRecommendations"][number] | null {
  const rows = (partialResult as { styleRecommendations?: unknown } | null)?.styleRecommendations;
  if (!Array.isArray(rows)) return null;
  const style = rows.find((row) => (row as { id?: unknown } | null)?.id === styleId);
  if (!style || typeof style !== "object") return null;
  const candidate = style as Partial<FirstRoundAgentOutput["styleRecommendations"][number]>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.nameZh === "string"
    && typeof candidate.description === "string"
    && typeof candidate.rationale === "string"
  ) ? candidate as FirstRoundAgentOutput["styleRecommendations"][number] : null;
}

export function createRecommendationApplication(deps: RecommendationApplicationDeps) {
  const { prisma } = deps;
  const photoAccess = createPhotoAccessService(prisma);

  /**
   * 输出校验。这一层在 provider 之外，因此换实现时它保持不变。
   * 不合格的候选被丢弃而非修补——修补等于替 provider 编数据。
   */
  function validateCandidates(
    raw: ProviderCandidate[],
    requestedCount: number,
  ): { kept: ProviderCandidate[]; rejected: { key: string; reason: string }[] } {
    const kept: ProviderCandidate[] = [];
    const rejected: { key: string; reason: string }[] = [];
    const seenKeys = new Set<string>();
    const seenNames = new Set<string>();

    for (const c of raw) {
      const key = c.providerCandidateKey ?? "(missing)";
      const fail = (reason: string) => rejected.push({ key, reason });

      if (!c.providerCandidateKey || !c.nameZh || !c.description || !c.modelRationale || !c.visualDirection) {
        fail("必填字段缺失");
        continue;
      }
      if (seenKeys.has(c.providerCandidateKey)) { fail("providerCandidateKey 重复"); continue; }
      if (seenNames.has(c.nameZh)) { fail("候选名称重复"); continue; }
      if (c.nameZh.length > LIMITS.nameZh || c.description.length > LIMITS.description
          || c.modelRationale.length > LIMITS.modelRationale || c.visualDirection.length > LIMITS.visualDirection) {
        fail("文本超长");
        continue;
      }
      // 守卫一律走归一化文本：`脸 型`、`臉型`、全角写法否则直接绕过。
      const allText = normalizeForGuard(`${c.nameZh}${c.description}${c.modelRationale}${c.visualDirection}`);

      // 人物图像生成的红线：任何字段命中即整条丢弃
      if (ALWAYS_REJECTED_DIRECTION.test(allText)) {
        fail("文案命中人物图像生成红线");
        continue;
      }
      if (OUT_OF_DOMAIN_DIRECTION.test(normalizeForGuard(c.visualDirection))) {
        fail("visualDirection 涉及本领域不允许修改的内容");
        continue;
      }
      // 确定性安全词库：与输入审核同一套，红线在这里也不放行
      if (reviewFreeInput(`${c.nameZh}${c.description}${c.visualDirection}`).kind === "blocked") {
        fail("文本未通过安全词库");
        continue;
      }
      // 诊断性表述守卫。modelRationale 会直接展示给用户，
      // 一个不能展示理由的候选是不可用的，所以整条丢弃而不是改写它的文案。
      if (DIAGNOSTIC_TERMS.test(normalizeForGuard(`${c.nameZh}${c.description}${c.modelRationale}`))) {
        fail("文案含诊断性表述");
        continue;
      }
      seenKeys.add(c.providerCandidateKey);
      seenNames.add(c.nameZh);
      kept.push(c);
    }

    // rank 唯一且连续从 1 起。provider 给的 rank 只作为排序依据，
    // 最终位次由应用模块重排——否则一个缺号就让整批不合格。
    kept.sort((a, b) => a.rank - b.rank);
    const capped = kept.slice(0, requestedCount);
    for (const [i, c] of capped.entries()) c.rank = i + 1;
    for (const c of kept.slice(requestedCount)) rejected.push({ key: c.providerCandidateKey, reason: "超出请求数量" });

    return { kept: capped, rejected };
  }

  /** 首轮的发型不能只“看起来”搭配某风格；关联必须由 tool schema 明确给出。 */
  function validateFirstRoundStylePairs(
    candidates: ProviderCandidate[],
    firstRound?: FirstRoundAgentOutput,
  ): { kept: ProviderCandidate[]; rejected: { key: string; reason: string }[] } {
    if (!firstRound) return { kept: candidates, rejected: [] };
    const offeredIds = new Set(firstRound.styleRecommendations.map((style) => style.id));
    const rejected: { key: string; reason: string }[] = [];
    const kept = candidates.filter((candidate) => {
      if (!candidate.styleDirectionId || !offeredIds.has(candidate.styleDirectionId)) {
        rejected.push({ key: candidate.providerCandidateKey, reason: "未关联首轮提供的风格方向" });
        return false;
      }
      return true;
    });
    const covered = new Set(kept.map((candidate) => candidate.styleDirectionId));
    if (covered.size !== offeredIds.size) {
      return {
        kept: [],
        rejected: [
          ...rejected,
          { key: "style-pairing", reason: "并非每个首轮风格方向都有匹配的发型候选" },
        ],
      };
    }
    return { kept, rejected };
  }

  /**
   * 客观属性解析。**按名称查服务端的属性表，不采信 provider 自报**。
   *
   * 实测过为什么不能采信：模型得知用户发际线偏后之后，把客观上露额的侧分背头与平顶
   * 都标成遮额；正常发际线场景下同类造型标成露额。同一类造型标注相反，
   * 且翻转方向朝着「能通过约束」。
   *
   * 命中表则该候选的属性是权威的（`catalog_verified`）；未命中则 `not_checked`，
   * 不执行硬过滤也不编造属性——表覆盖不到的造型，我们确实不知道它露不露额。
   */
  function resolveAttributes(kind: RecommendationKind, nameZh: string): {
    attributes: ProviderCandidate["estimatedAttributes"] | undefined;
    verificationStatus: CandidateVerificationStatus;
  } {
    if (kind !== "hairstyle") return { attributes: undefined, verificationStatus: "not_checked" };
    const hit = findObjectiveHairstyleAttributes(nameZh);
    if (!hit) return { attributes: undefined, verificationStatus: "not_checked" };
    return {
      attributes: { coversForehead: hit.coversForehead, requiresHairVolume: hit.requiresHairVolume },
      verificationStatus: "catalog_verified",
    };
  }

  /**
   * 渲染指令由这里构建，provider 不产出。
   * 若 provider 能直接给出送往图生图的完整 prompt，可替换 adapter 就获得了
   * 改动身份、背景、体型的通道，也可能与身份保持后缀冲突。
   *
   * 模板放在应用模块而非目录上：目录首版可以为空，模板不能因此缺失。
   */
  function buildRenderInstruction(kind: RecommendationKind, c: ProviderCandidate): string {
    let head: string;
    if (kind === "hairstyle") {
      // 命中属性表时用**表里的规范渲染描述**，而不是模型给的 visualDirection。
      // visualDirection 是没校验的自由文本，实测「三七侧分短发」被描述成
      // 「左侧头发剃短至耳下，右侧头发留长至肩膀附近」——名字是常规侧分、
      // 描述是极端不对称剪裁，图像模型忠实照画，产出一眼假的怪造型。
      // 名字来自这张表，渲染描述也应当来自这张表；只有表外（用户自报）的
      // 造型才退回模型描述。
      const attrs = findObjectiveHairstyleAttributes(c.nameZh);
      /*
       * **不把发型名写进指令。** 实测「把发型改成微碎盖：额前碎发盖住发际线…」
       * 在真人长发照上产出渐变背头、额头全露——与描述相反。模型不认这些中文
       * 发型名，会映射到错误先验，且名称的先验压倒后面的描述（加反向词也压不住）；
       * 同一条描述去掉名称立刻正确。名字只用于给用户展示。
       */
      const direction = attrs?.renderDescription ?? c.visualDirection;
      head = `把这个人的发型改成：${direction}`;
    } else {
      head = `换成这套穿搭：${c.visualDirection}`;
    }
    // 正向只留一句含"表情"的身份约束（实测缺了表情模型会自己加微笑），
    // 反磨皮的否定式走 NEGATIVE_PROMPT，两边都不挤占造型描述的长度预算。
    return `${head} ${identityConstraint(kind === "hairstyle" ? "头发" : "服装")}`;
  }

  /**
   * 抢占。**必须先于付费调用**：若改成"先调 provider 再落库"，两个并发请求会
   * 同时查不到就绪集合、同时调用付费 provider，最后才在唯一键上竞争——
   * 库里只留一个集合而费用发生了两次。
   *
   * 靠唯一键冲突判断胜负，不用 SELECT-then-INSERT（那中间有窗口）。
   */
  async function acquireSet(params: {
    planId: string;
    kind: RecommendationKind;
    generation: number;
    inputFingerprint: string;
    source: RecommendationSourceName;
    capabilityStatus: CapabilityStatus;
    injectedContext?: unknown;
  }): Promise<{ role: "creator" | "follower"; setId: string }> {
    const computationKey = stableHash({
      planId: params.planId,
      kind: params.kind,
      generation: params.generation,
      inputFingerprint: params.inputFingerprint,
    });

    // 快速路径：绝大多数重复请求（用户连点、超时重试）间隔远大于竞态窗口，
    // 这里就能命中，不必走唯一键冲突。这样做不是为了性能，而是为了日志——
    // Prisma 的 log 配置含 "error"，被 catch 的 P2002 也会打成 prisma:error，
    // 让预期路径看起来像故障。
    const fast = await prisma.recommendationSet.findUnique({ where: { computationKey } });
    if (fast) {
      /**
       * `failed` 与陈旧 `preparing` 必须可回收，否则同一输入永久拿不到结果。
       *
       * 首版直接把任何已存在的集合当 follower 返回，后果是：供应商抖动一次导致
       * `failed`，此后同一问卷+照片的每次请求都命中这条 failed 记录，用户永远
       * 拿不到候选；worker 中途被杀留下的 `preparing` 同理，客户端永远收到
       * 「请稍后重试」而没有任何东西会去重试。
       *
       * 回收 = 把它重置为 preparing 并成为创建者。竞态由后面的唯一键兜底：
       * 两个请求同时回收时，updateMany 的条件保证只有一个真的翻转了状态。
       */
      const isStalePreparing =
        fast.status === "preparing" && Date.now() - fast.updatedAt.getTime() > STALE_PREPARING_MS;
      if (fast.status === "failed" || isStalePreparing) {
        const reclaimed = await prisma.recommendationSet.updateMany({
          where: { id: fast.id, status: fast.status, updatedAt: fast.updatedAt },
          data: { status: "preparing", failureReason: null },
        });
        // 抢到重置权的成为创建者；没抢到的说明别人正在重跑，按 follower 读
        return reclaimed.count === 1
          ? { role: "creator", setId: fast.id }
          : { role: "follower", setId: fast.id };
      }
      return { role: "follower", setId: fast.id };
    }

    try {
      const created = await prisma.recommendationSet.create({
        data: {
          planId: params.planId,
          kind: params.kind,
          status: "preparing",
          computationKey,
          inputFingerprint: params.inputFingerprint,
          generation: params.generation,
          source: params.source,
          capabilityStatus: params.capabilityStatus as never,
          injectedContext: (params.injectedContext ?? undefined) as never,
        },
      });
      return { role: "creator", setId: created.id };
    } catch (err) {
      // P2002 = 唯一约束冲突，说明另一个请求在竞态窗口内先建了同一个集合。
      // 这是**预期路径**，不是故障；Prisma 仍会把它打成 prisma:error，属已知日志噪音。
      if ((err as { code?: string })?.code !== "P2002") throw err;
      const existing = await prisma.recommendationSet.findUnique({ where: { computationKey } });
      if (!existing) throw err;
      return { role: "follower", setId: existing.id };
    }
  }

  /**
   * follower 等创建者出结果，而不是立刻返回空候选。
   *
   * 为什么必须等：抢占的目的是「同一输入只付一次钱，且两个请求都拿到答案」。
   * 直接返回 `inProgress + candidates: []` 只实现了前一半——实测中 S3 的第二次调用
   * 就此让整个 job 落到 `completed_partial`，用户看到「请稍后重试」，
   * 而创建者几秒后已经把 3 条候选写好了。
   *
   * 这个等待在修正指纹（去掉非确定性的 semantics）之后才显现：在那之前两次调用
   * 算出不同的 computationKey，各自成为创建者、各自付费一次，症状是重复付费而非空结果。
   *
   * 超时不抛错，如实返回当时的状态：等待有上限，好过把请求挂死。
   */
  async function awaitCreator(setId: string): Promise<RecommendationSetView> {
    const deadline = Date.now() + FOLLOWER_WAIT_MS;
    for (;;) {
      const set = await prisma.recommendationSet.findUniqueOrThrow({
        where: { id: setId },
        select: { status: true },
      });
      if (set.status !== "preparing" || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, FOLLOWER_POLL_MS));
    }
    return loadView(setId, true);
  }

  async function loadView(setId: string, reused: boolean): Promise<RecommendationSetView> {
    const set = await prisma.recommendationSet.findUniqueOrThrow({
      where: { id: setId },
      include: { candidates: { orderBy: { rank: "asc" } } },
    });
    return {
      setId: set.id,
      kind: set.kind,
      status: set.status,
      generation: set.generation,
      capabilityStatus: set.capabilityStatus as unknown as CapabilityStatus,
      inProgress: set.status === "preparing",
      reused,
      candidates: set.candidates.map((c) => ({
        candidateId: c.id,
        nameZh: c.nameZh,
        description: c.description,
        modelRationale: c.modelRationale,
        rank: c.rank,
        renderInstruction: c.renderInstruction,
        verificationStatus: c.verificationStatus,
        estimatedAttributes: (c.estimatedAttributes ?? null) as CandidateView["estimatedAttributes"],
        styleDirectionId: c.styleDirectionId,
      })),
      firstRound: isFirstRoundOutput(set.injectedContext) ? set.injectedContext : undefined,
      failureReason: set.failureReason,
    };
  }

  /** 创建者路径：签照片 → 调 provider → 校验 → 事务落库 */
  async function runAsCreator(params: {
    setId: string;
    kind: RecommendationKind;
    userId: string;
    requestedCount: number;
    photoStorageKey?: string;
    /** 发型域必传：硬约束校验要拿它与目录属性比对 */
    hairSignals?: HairSignals;
    /**
     * 第二个参数是**前置告知 provider 的硬约束**。
     * 只做事后过滤是不够的：真实调用实测下来，发际线偏后 + 发量偏少的用户
     * （恰恰是这个产品的核心人群）模型给的 3 个候选会被全部剔除，集合直接 failed。
     * 约束不放宽，但要让 provider 一开始就在可行集里选。
     */
    buildInput: (photoReadUrl?: string, constraint?: HairConstraintContext) => unknown;
    provider: RecommendationApplicationDeps["hairstyleProvider"];
    workflow?: { jobId: string; planId?: string; stepName: string };
  }): Promise<RecommendationSetView> {
    try {
      // 照片授权走统一入口，签发即记录。纯文字路径不签发，也就不产生访问记录。
      let photoReadUrl: string | undefined;
      if (params.photoStorageKey) {
        photoReadUrl = (
          await photoAccess.issueReadUrl({
            storageKey: params.photoStorageKey,
            accessorType: "system_provider",
            accessorId: params.userId,
            purpose: params.kind === "hairstyle" ? "发型推荐" : "穿搭推荐",
            expiresSeconds: 600,
          })
        ).url;
      }

      // 约束在调用**之前**算出来，既送进 prompt 也用于事后过滤——
      // 同一份判定，两个用途，不会出现"告知的"与"执行的"不一致。
      const constraint =
        params.kind === "hairstyle" && params.hairSignals ? computeHairConstraint(params.hairSignals) : undefined;
      const constraintContext = constraint
        ? {
            requireCoversForehead: constraint.requireCoversForehead,
            excludeVolumeRequirements: constraint.excludeVolumeRequirements,
            rationale: constraint.rationale,
            feasibleNames: feasibleHairstyleNames(constraint),
          }
        : undefined;

      const startedAt = Date.now();
      const result = await params.provider.recommend(params.buildInput(photoReadUrl, constraintContext));
      if (params.workflow) {
        await recordWorkflowRun(prisma, {
          jobId: params.workflow.jobId,
          planId: params.workflow.planId,
          stepName: params.workflow.stepName,
          finalStatus: "completed",
          latencyMs: result.latencyMs ?? Date.now() - startedAt,
          provider: result.provider ?? params.provider.name,
          modelVersion: result.modelVersion ?? params.provider.version,
          qualityResult: result.callId ? { providerCallId: result.callId } : undefined,
        });
      }
      // 先持久化首轮的非候选输出。即便所有发型都被确定性硬约束剔除，用户仍应
      // 得到这次已付费调用的人脸结论与风格方向，而不是被迫再调用一次模型。
      if (result.firstRound) {
        await prisma.recommendationSet.update({
          where: { id: params.setId },
          data: { injectedContext: result.firstRound as never },
        });
      }
      const validated = validateCandidates(result.candidates, params.requestedCount);
      const paired = params.kind === "hairstyle"
        ? validateFirstRoundStylePairs(validated.kept, result.firstRound)
        : { kept: validated.kept, rejected: [] };
      const kept = paired.kept;
      const rejected = [...validated.rejected, ...paired.rejected];

      if (kept.length === 0) {
        await prisma.recommendationSet.update({
          where: { id: params.setId },
          data: {
            status: "failed",
            // 只写校验器给出的结构化原因，**不写 provider 原始响应**：
            // failureReason 会经 job.errorReason 回传客户端，
            // 把模型自由文本放进来等于绕过诊断词守卫直接展示给用户
            failureReason: `provider 未产出合格候选：${rejected.map((r) => r.reason).join("; ").slice(0, 300)}`,
          },
        });
        return loadView(params.setId, false);
      }

      // 候选写入与集合转 ready 在同一事务：避免出现「集合已 ready 但候选为空」
      // 逐条解析客观属性
      const resolvedAll = kept.map((c) => ({ c, ...resolveAttributes(params.kind, c.nameZh) }));

      /**
       * **拿用户信号与目录属性做真正的硬约束校验。**
       *
       * 此前这里只看「名称是否命中属性表」就写 catalog_verified，从不比对 hairSignals——
       * 于是发际线后移的用户拿到 coversForehead:false 的短寸，而系统报告「已校验通过」。
       * 把「查到了属性」当成「约束已校验」，是本项目反复出现的同一类错误。
       */
      let resolved = resolvedAll;
      let constraintApplied = false;
      let constraintDropped: { nameZh: string; reason: string }[] = [];

      const effectiveConstraint =
        constraint && result.firstRound
          ? computeHairConstraint(
              applySemanticHairlineVisibility(
                params.hairSignals ?? { hairline: "normal", volume: "unknown" },
                result.firstRound.faceAnalysis.structuredSemantic,
              ),
            )
          : constraint;

      if (effectiveConstraint) {
        const checkable = resolvedAll.filter((r) => r.attributes?.requiresHairVolume && r.attributes.coversForehead !== undefined);
        const { kept: keptRefs, excluded } = applyHairConstraint(
          checkable.map((r, i) => ({
            id: String(i),
            requiresHairVolume: r.attributes!.requiresHairVolume!,
            coversForehead: r.attributes!.coversForehead!,
          })),
          effectiveConstraint,
        );
        const keptIdx = new Set(keptRefs.map((k) => Number(k.id)));
        constraintDropped = excluded.map((e) => ({
          nameZh: checkable[Number(e.item.id)]!.c.nameZh,
          reason: e.reason,
        }));
        // 属性不可查的候选保留但标 not_checked——不能因为查不到就当它违规，
        // 也不能当它合规；这个区别体现在 feasibility 上。
        const unknownAttr = resolvedAll.filter((r) => !checkable.includes(r));
        resolved = [...checkable.filter((_, i) => keptIdx.has(i)), ...unknownAttr];
        constraintApplied = true;
      }

      // rank 因剔除而出现空洞时重排，保持连续
      resolved.sort((a, b) => a.c.rank - b.c.rank);
      resolved.forEach((r, i) => (r.c.rank = i + 1));

      /**
       * `catalog_verified` 只在**约束真的跑过、且每条候选的属性都查得到**时才成立。
       * 任一条件不满足即 `not_checked`——上游据此知道这一项未被校验。
       */
      const feasibility: CapabilityStatus["feasibility"] =
        constraintApplied && resolved.length > 0 && resolved.every((r) => r.verificationStatus === "catalog_verified")
          ? "catalog_verified"
          : "not_checked";

      if (resolved.length === 0) {
        await prisma.recommendationSet.update({
          where: { id: params.setId },
          data: {
            status: "failed",
            failureReason: `候选全部未通过可行性校验（不放宽约束）：${constraintDropped.map((d) => `${d.nameZh}—${d.reason}`).join("; ").slice(0, 250)}`,
          },
        });
        return loadView(params.setId, false);
      }

      await prisma.$transaction(async (tx) => {
        for (const { c, attributes, verificationStatus } of resolved) {
          await tx.recommendationCandidate.create({
            data: {
              setId: params.setId,
              catalogVariantId: c.catalogVariantId,
              providerCandidateKey: c.providerCandidateKey,
              nameZh: c.nameZh,
              description: c.description,
              modelRationale: c.modelRationale,
              rank: c.rank,
              visualDirection: c.visualDirection,
              styleDirectionId: c.styleDirectionId,
              renderInstruction: buildRenderInstruction(params.kind, c),
              estimatedAttributes: (attributes ?? undefined) as never,
              verificationStatus,
            },
          });
        }
        // 集合的 capabilityStatus 按实际解析结果回写，而不是调用前的预判
        const current = await tx.recommendationSet.findUniqueOrThrow({ where: { id: params.setId } });
        const status = current.capabilityStatus as unknown as CapabilityStatus;
        await tx.recommendationSet.update({
          where: { id: params.setId },
          data: {
            status: "ready",
            capabilityStatus: { ...status, feasibility } as never,
            injectedContext: result.firstRound ? result.firstRound as never : undefined,
          },
        });
      });

      return loadView(params.setId, false);
    } catch (err) {
      if (params.workflow) {
        await recordWorkflowRun(prisma, {
          jobId: params.workflow.jobId,
          planId: params.workflow.planId,
          stepName: params.workflow.stepName,
          finalStatus: "failed",
          provider: params.provider.name,
          modelVersion: params.provider.version,
        });
      }
      await prisma.recommendationSet.update({
        where: { id: params.setId },
        // provider 抛出的错误可能含模型原始文本（见 multimodalAgentRecommendation
        // 把响应前 200 字放进 Error）。只记类型不记内容，避免它经 errorReason
        // 绕过诊断词守卫展示给用户；原文留在服务端日志里排查。
        data: { status: "failed", failureReason: "推荐调用失败（详情见服务端日志）" },
      });
      throw err;
    }
  }

  return {
    /**
     * JSON 系统衣柜的唯一应用层入口。目录不是用户数据，不落库；固定流程和 Agent
     * 都从同一套已审核的风格 → 公式 → 槽位排序获取结果。
     */
    recommendWardrobe(profile: WardrobeProfile, request: RecommendWardrobeRequest) {
      return recommendWardrobe(profile, request);
    },

    async recommendHairstyles(command: {
      userId: string;
      planId: string;
      requestedCount: number;
      frontPhotoStorageKey: string;
      geometry: unknown;
      hairSignals: unknown;
      clientSignals?: unknown;
      /** 兼容已有调用方；首轮实现不再单独消费该字段。 */
      semantics?: unknown;
      preference?: unknown;
      changeWillingness?: string | null;
      catalogVariants?: unknown[];
      generation?: number;
      /** 固定管道传入以审计实际发生的付费 provider 调用。 */
      workflow?: { jobId: string; stepName: string };
    }): Promise<RecommendationSetView> {
      const provider = deps.hairstyleProvider;
      const capabilityStatus: CapabilityStatus = {
        knowledgeSource: provider.source,
        // 落库时按属性表的实际命中情况回写；这里只是抢占阶段的初值
        feasibility: "not_checked",
        outfitCoordination: "not_checked",
        previewQuality: "not_checked",
      };
      const inputFingerprint = stableHash({
        geometry: command.geometry,
        hairSignals: command.hairSignals,
        // 客户端测算是确定性输入，必须进指纹；同一照片的不同测量值不能复用旧推荐。
        clientSignals: command.clientSignals ?? null,
        preference: command.preference ?? null,
        changeWillingness: command.changeWillingness ?? null,
        requestedCount: command.requestedCount,
        // provider 标识与实现版本进指纹：切换实现后旧集合不被复用，
        // 否则新实现在存量用户上永远不生效
        provider: `${provider.name}@${provider.version}`,
      });

      const { role, setId } = await acquireSet({
        planId: command.planId,
        kind: "hairstyle",
        generation: command.generation ?? 1,
        inputFingerprint,
        source: provider.source,
        capabilityStatus,
      });
      if (role === "follower") return awaitCreator(setId);

      return runAsCreator({
        setId,
        kind: "hairstyle",
        userId: command.userId,
        requestedCount: command.requestedCount,
        photoStorageKey: command.frontPhotoStorageKey,
        hairSignals: command.hairSignals as HairSignals,
        provider,
        workflow: command.workflow
          ? { ...command.workflow, planId: command.planId }
          : undefined,
        buildInput: (photoReadUrl, constraint) => ({
          photoReadUrl,
          geometry: command.geometry,
          hairSignals: command.hairSignals,
          // 硬约束前置：不给的话模型会在注定被剔除的方向上浪费整批候选
          constraint,
          clientSignals: command.clientSignals,
          preference: command.preference,
          changeWillingness: command.changeWillingness,
          requestedCount: command.requestedCount,
          catalogVariants: command.catalogVariants,
        }),
      });
    },

    async recommendOutfits(command: {
      userId: string;
      planId: string;
      requestedCount: number;
      selectedHairstyleCandidateId: string;
      body?: unknown;
      scene?: unknown;
      weather?: unknown;
      budgetTier?: string | null;
      /** 仅在有全身照且要出图时提供；纯文字路径不传，因此不签发也不留访问记录 */
      fullBodyPhotoStorageKey?: string;
      catalogVariants?: unknown[];
      /** 首轮选定的大风格，作为穿搭推荐的硬上下文。 */
      selectedStyle?: unknown;
      /** 人脸信息（几何 / 语义 / 发量信号 / 已选发型的风格向量），供 LLM 判断版型与配色 */
      face?: unknown;
      generation?: number;
      /** 固定管道传入以审计实际发生的付费 provider 调用。 */
      workflow?: { jobId: string; stepName: string };
    }): Promise<RecommendationSetView> {
      const provider = deps.outfitProvider;
      const selected = await prisma.recommendationCandidate.findUnique({
        where: { id: command.selectedHairstyleCandidateId },
        include: { set: true },
      });
      if (!selected || selected.set.planId !== command.planId) {
        throw new Error("已选发型候选不存在或不属于该方案");
      }

      const capabilityStatus: CapabilityStatus = {
        knowledgeSource: provider.source,
        feasibility: "not_checked",
        // 本版有意由 Agent 判断：风格数据量不足（12 发型 / 5 穿搭），
        // 用没校准的四轴阈值过滤只会把候选饿死（见 jobOrchestrator 的说明）
        outfitCoordination: "agent_estimated",
        previewQuality: "not_checked",
      };
      const inputFingerprint = stableHash({
        selectedHairstyle: selected.nameZh,
        body: command.body ?? null,
        scene: command.scene ?? null,
        weather: command.weather ?? null,
        budgetTier: command.budgetTier ?? null,
        hasFullBody: Boolean(command.fullBodyPhotoStorageKey),
        requestedCount: command.requestedCount,
        // 人脸信息进指纹：脸型/肤色变了，缓存的推荐就不该复用
        face: command.face ?? null,
        selectedStyle: command.selectedStyle ?? null,
        provider: `${provider.name}@${provider.version}`,
      });

      const { role, setId } = await acquireSet({
        planId: command.planId,
        kind: "outfit",
        generation: command.generation ?? 1,
        inputFingerprint,
        source: provider.source,
        capabilityStatus,
        injectedContext: { scene: command.scene ?? null, weather: command.weather ?? null },
      });
      if (role === "follower") return awaitCreator(setId);

      return runAsCreator({
        setId,
        kind: "outfit",
        userId: command.userId,
        requestedCount: command.requestedCount,
        photoStorageKey: command.fullBodyPhotoStorageKey,
        provider,
        workflow: command.workflow
          ? { ...command.workflow, planId: command.planId }
          : undefined,
        buildInput: (photoReadUrl) => ({
          selectedHairstyle: { candidateId: selected.id, nameZh: selected.nameZh, description: selected.description },
          body: command.body,
          scene: command.scene,
          weather: command.weather,
          budgetTier: command.budgetTier,
          fullBodyPhotoReadUrl: photoReadUrl,
          requestedCount: command.requestedCount,
          catalogVariants: command.catalogVariants,
          face: command.face,
          selectedStyle: command.selectedStyle,
        }),
      });
    },

    /** 只接受属于本用户、且所属集合为 ready 的候选 */
    async selectCandidate(command: { userId: string; planId: string; candidateId: string }): Promise<SelectionResult> {
      const candidate = await prisma.recommendationCandidate.findUnique({
        where: { id: command.candidateId },
        include: { set: { include: { plan: { select: { userId: true, selectedStyle: true } } } } },
      });
      if (!candidate) return { ok: false, reason: "not_found" };
      if (candidate.set.planId !== command.planId || candidate.set.plan.userId !== command.userId) {
        return { ok: false, reason: "not_owned" };
      }
      if (candidate.set.status !== "ready") return { ok: false, reason: "set_not_ready" };
      if (candidate.set.kind === "hairstyle") {
        const selectedStyleId = (candidate.set.plan.selectedStyle as { id?: unknown } | null)?.id;
        if (typeof selectedStyleId !== "string") return { ok: false, reason: "style_not_selected" };
        if (candidate.styleDirectionId !== selectedStyleId) {
          return { ok: false, reason: "candidate_not_in_selected_style" };
        }
      }

      const field = candidate.set.kind === "hairstyle" ? "selectedHairstyleId" : "selectedOutfitId";
      await prisma.$transaction(async (tx) => {
        await tx.appearancePlan.update({ where: { id: command.planId }, data: { [field]: candidate.id } });
        await tx.conversationDecision.create({
          data: {
            planId: command.planId,
            decisionKind: "style_selected",
            payload: { kind: candidate.set.kind, candidateId: candidate.id, nameZh: candidate.nameZh },
          },
        });
      });
      return { ok: true, candidateId: candidate.id, nameZh: candidate.nameZh };
    },

    /** 原子选定首轮提供的一个风格—发型组合，避免短暂写入跨风格状态。 */
    async selectStyleAndHairstyle(command: {
      userId: string;
      planId: string;
      styleId: string;
      candidateId: string;
    }): Promise<SelectionResult> {
      return prisma.$transaction(async (tx): Promise<SelectionResult> => {
        const plan = await tx.appearancePlan.findFirst({
          where: { id: command.planId, userId: command.userId },
          select: { id: true },
        });
        if (!plan) return { ok: false, reason: "not_owned" };
        const firstRound = await tx.analysisJob.findFirst({
          where: {
            userId: command.userId,
            planId: command.planId,
            jobType: "initial_analysis",
            status: { in: ["completed", "completed_partial"] },
          },
          orderBy: { createdAt: "desc" },
          select: { partialResult: true },
        });
        const style = findPersistedStyleDirection(firstRound?.partialResult, command.styleId);
        if (!style) return { ok: false, reason: "style_not_offered" };
        const candidate = await tx.recommendationCandidate.findUnique({
          where: { id: command.candidateId },
          include: { set: true },
        });
        if (!candidate) return { ok: false, reason: "not_found" };
        if (candidate.set.planId !== command.planId) return { ok: false, reason: "not_owned" };
        if (candidate.set.kind !== "hairstyle" || candidate.set.status !== "ready") {
          return { ok: false, reason: "set_not_ready" };
        }
        if (candidate.styleDirectionId !== style.id) {
          return { ok: false, reason: "candidate_not_in_selected_style" };
        }
        await tx.appearancePlan.update({
          where: { id: command.planId },
          data: { selectedStyle: style as never, selectedHairstyleId: candidate.id },
        });
        await tx.conversationDecision.createMany({
          data: [
            { planId: command.planId, decisionKind: "style_direction_selected", payload: style as never },
            {
              planId: command.planId,
              decisionKind: "style_selected",
              payload: { kind: "hairstyle", candidateId: candidate.id, nameZh: candidate.nameZh },
            },
          ],
        });
        return { ok: true, candidateId: candidate.id, nameZh: candidate.nameZh };
      });
    },

    /** 仅供测试与运维观察 */
    __internals: { validateCandidates, validateFirstRoundStylePairs, buildRenderInstruction, stableHash },
  };
}

export type RecommendationApplication = ReturnType<typeof createRecommendationApplication>;
