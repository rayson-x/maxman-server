import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type {
  RecommendationKind,
  CandidateVerificationStatus,
} from "../generated/prisma/enums.js";
import { createPhotoAccessService } from "./photoAccessService.js";
import { IDENTITY_PRESERVATION_SUFFIX } from "./targetImageService.js";
import { reviewFreeInput } from "../features/appearance-agent/data/domainLexicon.js";
import { findObjectiveHairstyleAttributes } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";

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
};

export type SelectionResult =
  | { ok: true; candidateId: string; nameZh: string }
  | { ok: false; reason: "not_found" | "not_owned" | "set_not_ready" };

/** 候选文本的长度上限。超长的多半是模型把整段说明塞进了字段 */
const LIMITS = { nameZh: 40, description: 300, modelRationale: 400, visualDirection: 300 } as const;

/**
 * `visualDirection` 允许描述的范围。
 * 越界的例子：改变脸型骨骼、性别、年龄、背景、体型——这些由固定模板统一禁止，
 * 若 provider 又在描述里要求，两边会冲突。
 */
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
    recommend(input: unknown): Promise<{ candidates: ProviderCandidate[]; callId?: string }>;
  };
  outfitProvider: {
    readonly name: string;
    readonly version: string;
    readonly source: RecommendationSourceName;
    recommend(input: unknown): Promise<{ candidates: ProviderCandidate[]; callId?: string }>;
  };
};

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
      if (OUT_OF_DOMAIN_DIRECTION.test(c.visualDirection)) {
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
      if (DIAGNOSTIC_TERMS.test(`${c.nameZh}${c.description}${c.modelRationale}`)) {
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
    const head = kind === "hairstyle"
      ? `把发型改成${c.nameZh}：${c.visualDirection}`
      : `换成这套穿搭：${c.nameZh}：${c.visualDirection}`;
    return `${head} ${IDENTITY_PRESERVATION_SUFFIX}`;
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
    if (fast) return { role: "follower", setId: fast.id };

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
      })),
    };
  }

  /** 创建者路径：签照片 → 调 provider → 校验 → 事务落库 */
  async function runAsCreator(params: {
    setId: string;
    kind: RecommendationKind;
    userId: string;
    requestedCount: number;
    photoStorageKey?: string;
    buildInput: (photoReadUrl?: string) => unknown;
    provider: RecommendationApplicationDeps["hairstyleProvider"];
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

      const result = await params.provider.recommend(params.buildInput(photoReadUrl));
      const { kept, rejected } = validateCandidates(result.candidates, params.requestedCount);

      if (kept.length === 0) {
        await prisma.recommendationSet.update({
          where: { id: params.setId },
          data: {
            status: "failed",
            failureReason: `provider 未产出合格候选：${rejected.map((r) => r.reason).join("; ").slice(0, 300)}`,
          },
        });
        return loadView(params.setId, false);
      }

      // 候选写入与集合转 ready 在同一事务：避免出现「集合已 ready 但候选为空」
      // 逐条解析客观属性；同时汇总为集合级的 feasibility（取最弱的那一档）
      const resolved = kept.map((c) => ({ c, ...resolveAttributes(params.kind, c.nameZh) }));
      const feasibility: CapabilityStatus["feasibility"] =
        resolved.length > 0 && resolved.every((r) => r.verificationStatus === "catalog_verified")
          ? "catalog_verified"
          : "not_checked";

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
          data: { status: "ready", capabilityStatus: { ...status, feasibility } as never },
        });
      });

      return loadView(params.setId, false);
    } catch (err) {
      await prisma.recommendationSet.update({
        where: { id: params.setId },
        data: { status: "failed", failureReason: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
      });
      throw err;
    }
  }

  return {
    async recommendHairstyles(command: {
      userId: string;
      planId: string;
      requestedCount: number;
      frontPhotoStorageKey: string;
      geometry: unknown;
      hairSignals: unknown;
      semantics?: unknown;
      preference?: unknown;
      changeWillingness?: string | null;
      catalogVariants?: unknown[];
      generation?: number;
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
        semantics: command.semantics ?? null,
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
      if (role === "follower") return loadView(setId, true);

      return runAsCreator({
        setId,
        kind: "hairstyle",
        userId: command.userId,
        requestedCount: command.requestedCount,
        photoStorageKey: command.frontPhotoStorageKey,
        provider,
        buildInput: (photoReadUrl) => ({
          photoReadUrl,
          geometry: command.geometry,
          hairSignals: command.hairSignals,
          semantics: command.semantics,
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
      generation?: number;
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
        // 协调判定依赖风格向量四轴，数据未就绪时由 Agent 主观判断
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
      if (role === "follower") return loadView(setId, true);

      return runAsCreator({
        setId,
        kind: "outfit",
        userId: command.userId,
        requestedCount: command.requestedCount,
        photoStorageKey: command.fullBodyPhotoStorageKey,
        provider,
        buildInput: (photoReadUrl) => ({
          selectedHairstyle: { candidateId: selected.id, nameZh: selected.nameZh, description: selected.description },
          body: command.body,
          scene: command.scene,
          weather: command.weather,
          budgetTier: command.budgetTier,
          fullBodyPhotoReadUrl: photoReadUrl,
          requestedCount: command.requestedCount,
          catalogVariants: command.catalogVariants,
        }),
      });
    },

    /** 只接受属于本用户、且所属集合为 ready 的候选 */
    async selectCandidate(command: { userId: string; planId: string; candidateId: string }): Promise<SelectionResult> {
      const candidate = await prisma.recommendationCandidate.findUnique({
        where: { id: command.candidateId },
        include: { set: { include: { plan: { select: { userId: true } } } } },
      });
      if (!candidate) return { ok: false, reason: "not_found" };
      if (candidate.set.planId !== command.planId || candidate.set.plan.userId !== command.userId) {
        return { ok: false, reason: "not_owned" };
      }
      if (candidate.set.status !== "ready") return { ok: false, reason: "set_not_ready" };

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

    /** 仅供测试与运维观察 */
    __internals: { validateCandidates, buildRenderInstruction, stableHash },
  };
}

export type RecommendationApplication = ReturnType<typeof createRecommendationApplication>;
