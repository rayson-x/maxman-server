import type { FastifyInstance } from "fastify";
import { requireUser } from "../plugins/session.js";
import {
  basicQuestionnaireSchema,
  fullQuestionnaireSchema,
  faceShapeConfirmationSchema,
  hairIntentSchema,
  photoConsentSchema,
  photoRegistrationSchema,
} from "../schemas/intake.js";
import {
  saveBasicQuestionnaire,
  saveFullQuestionnaire,
  confirmFaceShape,
  getComputedFaceShape,
} from "../services/intakeService.js";
import { reviewFreeInput, normalizeToStyleTag, BLOCKED_MESSAGES } from "../features/appearance-agent/data/domainLexicon.js";
import { getInputReviewProvider } from "../features/appearance-agent/composition.js";
import { buildStorageKey, createPresignedUploadUrl, isOSSConfigured, putBuffer } from "../lib/ossUpload.js";

/** tasks 3.3-3.8：问卷、同意、照片、脸型确认、发型意向 */
export async function registerIntakeRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.container;

  app.post("/questionnaire/basic", async (req, reply) => {
    const user = requireUser(req);
    const input = basicQuestionnaireSchema.parse(req.body);
    await saveBasicQuestionnaire(prisma, user.id, input);
    return reply.send({ ok: true });
  });

  app.post("/questionnaire/full", async (req, reply) => {
    const user = requireUser(req);
    const input = fullQuestionnaireSchema.parse(req.body);
    const { contradictions } = await saveFullQuestionnaire(prisma, user.id, input);
    // 矛盾不阻断保存——先存下来再请用户澄清，避免用户白填一遍
    return reply.send({ ok: true, contradictions });
  });

  app.post("/photos/consent", async (req, reply) => {
    const user = requireUser(req);
    const input = photoConsentSchema.parse(req.body);
    const record = await prisma.consentRecord.create({
      data: {
        userId: user.id,
        consentType: input.consentType,
        version: input.version,
        snapshotTextRef: input.snapshotTextRef,
        sourceIp: req.ip,
      },
    });
    return reply.code(201).send({ consentId: record.id, grantedAt: record.grantedAt });
  });

  /**
   * 签发预签名上传 URL（tasks 3.6 前半）。客户端拿到后直传对象存储，
   * 不经服务端中转。人脸照片走私有 Bucket，链接短时有效。
   */
  app.post("/photos/upload-url", async (req, reply) => {
    const user = requireUser(req);
    const { photoType, contentType } = req.body as { photoType?: string; contentType?: string };
    if (!photoType) return reply.code(400).send({ error: "缺少 photoType" });
    if (!isOSSConfigured()) return reply.code(503).send({ error: "对象存储未配置" });

    const ext = contentType?.includes("png") ? "png" : "jpg";
    const key = buildStorageKey("raw", user.id, `${photoType}-${Date.now()}.${ext}`);
    const presigned = createPresignedUploadUrl(key, { contentType });
    return reply.send(presigned);
  });

  /**
   * 中转上传（预签名直传的兜底路径）。
   * 浏览器直连 OSS 的预签名 PUT 受 bucket CORS 约束（控制台配置缺失时整条直传链路不可用），
   * 中转路径让浏览器只跟本服务通信（CORS 已配），服务端用 SDK 写 OSS，bucket 侧零配置。
   * 代价是流量经服务端中转，MVP 阶段照片几 MB 可接受。
   */
  app.post(
    "/photos/upload-relay",
    { bodyLimit: 15 * 1024 * 1024 },
    async (req, reply) => {
      const user = requireUser(req);
      const { photoType, contentType } = req.query as { photoType?: string; contentType?: string };
      if (!photoType) return reply.code(400).send({ error: "缺少 photoType" });
      if (!isOSSConfigured()) return reply.code(503).send({ error: "对象存储未配置" });
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "请求体必须为 application/octet-stream 的图片字节" });
      }

      const ext = contentType?.includes("png") ? "png" : "jpg";
      const key = buildStorageKey("raw", user.id, `${photoType}-${Date.now()}.${ext}`);
      await putBuffer(key, body);
      return reply.code(201).send({ storageKey: key });
    }
  );

  /**
   * 上传完成回调登记（tasks 3.6 后半）。
   * 只有收到这一步才登记 UserPhoto 并进入内容安全审核——否则一次失败的直传
   * 会留下一条指向不存在对象的记录。
   */
  app.post("/photos", async (req, reply) => {
    const user = requireUser(req);
    const input = photoRegistrationSchema.parse(req.body);
    const photo = await prisma.userPhoto.create({
      data: {
        userId: user.id,
        photoType: input.photoType,
        storageKey: input.storageKey,
        faceMetrics: (input.faceMetrics ?? undefined) as never,
        moderationStatus: "pending",
      },
    });
    return reply.code(201).send({ photoId: photo.id, moderationStatus: photo.moderationStatus });
  });

  /** tasks 3.7：返回客户端算出的脸型 + 置信度 + 支撑比值，供用户确认 */
  app.get("/face-shape/computed", async (req, reply) => {
    const user = requireUser(req);
    const computed = await getComputedFaceShape(prisma, user.id);
    if (!computed) return reply.code(404).send({ error: "尚无可用的正面照测量数据" });
    return reply.send(computed);
  });

  app.post("/face-shape/confirm", async (req, reply) => {
    const user = requireUser(req);
    const input = faceShapeConfirmationSchema.parse(req.body);
    await confirmFaceShape(prisma, user.id, input.confirmedFaceShape);
    return reply.send({ ok: true, confirmedFaceShape: input.confirmedFaceShape });
  });

  /**
   * tasks 3.8：发型意向 gate + 自由输入的第一层审核。
   *
   * 第一层是确定性词库匹配，零成本、可审计。通过后才值得花 LLM 调用做第二层。
   * 红线阻断在这里就终止，不进入第二层——模型可能被说服，规则不会。
   */
  app.post("/intake/hair-intent", async (req, reply) => {
    const user = requireUser(req);
    const input = hairIntentSchema.parse(req.body);

    if (!input.hasPreference) {
      return reply.send({ hasPreference: false, next: "recommendation_only" });
    }

    const text = input.preferenceText!.trim();
    const verdict = reviewFreeInput(text);

    if (verdict.kind === "blocked") {
      return reply.code(422).send({
        accepted: false,
        reason: "blocked",
        category: verdict.category,
        message: BLOCKED_MESSAGES[verdict.category],
      });
    }

    // ⚠ `out_of_domain` **不终止**，继续进第二层。
    //
    // 这里踩过一次坑：早先把 out_of_domain 当终止条件，结果「想让下颌线条看起来更
    // 清晰立体」「眼睛看起来大一点」这类**越界但用视觉修饰措辞、且不含造型词汇**的
    // 输入全被判为 out_of_domain，用户收到「没太理解你说的方向」这种答非所问的回复，
    // 而真正该判断它的第二层被跳过了。
    //
    // 根因是把两个强度不同的信号做成了同级终止条件：`blocked` 是强信号（无歧义），
    // 而 `out_of_domain` 是弱信号（词库按设计就不可能穷尽中文表述）。让弱信号抢在
    // 强检查之前终止，顺序就错了。现在只有 `blocked` 终止，其余一律交第二层判断
    // 「真的无关」/「有关但越界」/「有关但词库没收」。
    const layer1Kind = verdict.kind;
    const matchedTerms = layer1Kind === "in_domain" ? verdict.matchedTerms : [];

    // ── 第二层：LLM 越界审核（tasks 4.2）──
    // 第一层拦无歧义的越界，第二层判有歧义的、以及词库覆盖不到的新说法。
    // 缺任何一层都不行：只靠 LLM 会被迂回表述说服，只靠词库必然有遗漏。
    let secondLayer: { allowed: boolean; category: string | null; message: string; reasoning: string } | null = null;
    try {
      const review = await getInputReviewProvider().review({ text, matchedDomainTerms: matchedTerms });
      secondLayer = {
        allowed: review.verdict.allowed,
        category: review.verdict.violationCategory,
        message: review.verdict.userMessage,
        reasoning: review.verdict.reasoning,
      };
    } catch (err) {
      // 第二层不可用时的取舍：**放行**并标记未审。
      // 理由：第一层已经拦住了所有无歧义的越界请求，剩下的是灰区；
      // 因为审核服务抖动就拒绝用户正常的发型诉求，代价高于让一个灰区表述通过——
      // 而且下游生成还有身份保留硬约束兜底。
      app.log.warn({ err }, "第二层 LLM 审核不可用，按第一层结果降级处理");
      // 降级取舍分两种情况：
      //   in_domain     → 放行并标记未审。第一层已拦住无歧义越界，剩下是灰区；
      //                    因审核服务抖动拒掉用户正常的发型诉求代价更高，
      //                    且下游生成还有身份保留硬约束兜底。
      //   out_of_domain → 拒绝。既没命中领域词，也无第二层背书，没有任何证据
      //                    表明它在业务范畴内，放行只会把垃圾输入送进生成环节。
      if (layer1Kind === "out_of_domain") {
        return reply.code(422).send({
          accepted: false,
          reason: "out_of_domain",
          message: "没太理解你说的方向，可以换个说法描述你想要的发型或风格吗？比如「想剪个碎盖」「想显得精神一点」。",
          reviewUnavailable: true,
        });
      }
    }

    if (secondLayer && !secondLayer.allowed) {
      const isOffTopic = secondLayer.category === "out_of_scope";
      return reply.code(422).send({
        accepted: false,
        reason: isOffTopic ? "out_of_domain" : "blocked_by_review",
        category: secondLayer.category,
        message:
          secondLayer.message ||
          (isOffTopic
            ? "没太理解你说的方向，可以换个说法描述你想要的发型或风格吗？"
            : "这个方向超出了我们能做的范围。"),
        layer: 2,
      });
    }

    const styleTag = normalizeToStyleTag(text);

    // 落库，否则 worker 里的 S3 读不到（决策 3 的「用户有中意发型」分支）。
    // 用 update 而非 upsert：走到这一步必然已过问卷，profile 一定存在；
    // 若不存在则是流程被绕过，那更应该报错而不是悄悄补建一条半空的 profile。
    await prisma.appearanceProfile.update({
      where: { userId: user.id },
      data: {
        stylePreferenceText: text,
        stylePreferenceStyleTag: styleTag,
        stylePreferenceUserSpecified: styleTag === null,
      },
    });

    return reply.send({
      accepted: true,
      matchedTerms,
      // 命中目录 tag → 用审核过的文案生成；未命中 → 走「用户指定方向」路径并标注
      normalizedStyleTag: styleTag,
      labelAsUserSpecified: styleTag === null,
      secondLayerReviewed: secondLayer !== null,
      layer1Kind,
      userId: user.id,
    });
  });
}
