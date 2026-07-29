import type { HairVolumeRequirement } from "../rules/hairConstraints.js";

export type ObjectiveHairstyleAttributes = {
  canonicalName: string;
  aliases: readonly string[];
  requiresHairVolume: HairVolumeRequirement;
  coversForehead: boolean;
  /**
   * 送往图生图的**规范视觉描述**。
   *
   * 为什么不直接用模型给的 `visualDirection`：那是没校验的自由文本，实测出现过
   * 「三七侧分短发」被描述成「左侧头发剃短至耳下，右侧头发留长至肩膀附近」——
   * 名字是常规侧分，描述是极端不对称剪裁，图像模型忠实地把这段胡话画了出来，
   * 结果就是一眼假。名字既然来自这张表，渲染描述也应当来自这张表。
   *
   * 写法约束（都是实测得出的）：
   *   1. **不写发型名**。实测「把发型改成微碎盖：额前碎发盖住发际线…」在真人长发照上
   *      产出的是渐变背头、额头全露 —— 与描述正好相反。模型不认这些中文发型名，
   *      把它映射到错误先验（男士短发＝渐变背头），而**名称的先验压倒了后面的描述**：
   *      同一条描述去掉名称立刻正确，而加反向词（背头/露出额头/向后梳）压不住。
   *   2. **最具辨识度的特征放最前面**（有没有刘海、盖不盖额头），模型对句首更敏感。
   *   3. 只写头发本身的形状与长短，≤30 字，不含背景/身份/体型措辞。
   *   4. 不用否定式 —— 扩散类编辑模型对正向 prompt 里的否定处理很弱。
   *   5. **分缝/背头这类要显式写顶部长度**。实测「按三比七分出发缝，短发向侧后梳
   *      服帖，露出额头」在真人照上产出的是寸头 —— "短发＋服帖＋露额" 被读成了
   *      "剪到很短"，分缝完全消失。给出「顶部留五六厘米长」才保住长度。
   *   6. 措辞要避开"施工感"动词。「压出一道清晰发缝」被读成**剃出来的硬分缝**、
   *      「两侧剪短贴头」被读成**铲青**。改用「梳出自然分缝」「修短但保留发量」。
   *   7. 描述取材于中文互联网上理发师/发型指南的实际说法（搜狐、新浪、网易、
   *      伊秀、好发型等），长度统一用公分——原文就是这么给的，模型对具体数字
   *      比对"短/长"这类形容词敏感得多。两处关键纠错来自这些材料：
   *        · 三七分/侧分**要留刘海稍遮额角、且必须蓬松**。原先写"露出额头 + 梳顺
   *          服帖"正好写反，产出油头——原文明确"贴在头上的三七分和汉奸头差不多"。
   *        · 中分是**顶部到耳朵长度 + 刘海过眉**，不是寸头也不是齐肩波波头。
   *   8. **强度词会被放大**。「抓成短刺」+「发丝分束」出成了莫西干；
   *      改成「向上抬起一点」。同理短发款要写明总长上限（"不过耳"），
   *      否则模型倾向保留原图长度 —— 中分短发出成了齐肩波波头。
   */
  renderDescription: string;
  /**
   * 该款式在**补充发量前提**（戴假发）下的可行性。
   *
   * **留空 = 未判定 = 不可行（fail closed）。** 这不是待办遗留，是刻意的默认值：
   * 标错的代价是让用户花钱买一顶做不出目标效果的假发，比少推荐一款严重得多。
   * 所以结构可以先于数据落地——全表留空时假发方案自动为空，系统行为与从前一致。
   *
   * 回填依据来自男士**日常自然向**假发工艺调研，范围明确排除 cosplay / 彩色 /
   * 舞台 / 女式假发。
   */
  wigFeasibility?: WigFeasibilityAnnotation;
};

/**
 * 假发工艺档位。档位是「做出该款式所需的**最低**工艺」，不是推荐买什么。
 *
 * `volume_patch`  —— 只需补量感（发片 / 局部补发）。适用于只被发量挡住、本身遮额的款式。
 * `full_wig`      —— 需要整顶更换。适用于被「遮额」挡住的款式：自身发际线做不到，假发的
 *                    发际线才做得到。
 * `full_wig_front_lace` —— 需要整顶且前额工艺过关。适用于把发际线完全暴露在正面的款式，
 *                    自然度强依赖前额网底工艺，不是所有价位都做得到。
 */
export type WigCraftTier = "volume_patch" | "full_wig" | "full_wig_front_lace";

/**
 * 依据强度。**这里没有 `measured`**——标注「实测」需要真实购买样本做实拍对照，
 * 本仓库目前没有。类型层面挡住它，比靠注释提醒可靠。有了实拍再扩这个联合类型。
 */
export type WigEvidenceStrength = "reasoned" | "product_decision";

export type WigFeasibilityAnnotation =
  | {
      feasible: true;
      minimumTier: WigCraftTier;
      /**
       * 达成这一款还需要用户知道的限制条件，会拼进面向用户的达成路径文案。
       *
       * 目前只有一类：需要烫卷纹理的款式不能用普通化纤补量 —— 蛋白丝不可烫染、
       * 不可近高温。不写出来，用户会买一片做不出目标效果的发片。
       */
      caveat?: string;
      evidenceStrength: WigEvidenceStrength;
    }
  | { feasible: false; reason: string; evidenceStrength: WigEvidenceStrength };

/**
 * 发型渲染文案是按 Seedream 4.5 的指令结构逐款校准的。
 * Provider 或模型一旦变化，名称锚点、约束位置乃至措辞都会失效，必须重新校准；
 * 未命中本精确标识时，目标图服务会跳过发型变更，不能静默复用旧 prompt。
 */
export const HAIRSTYLE_RENDER_CALIBRATION = {
  providerName: "ark-seedream-image-edit(doubao-seedream-4-5-251128)",
  promptVersion: "seedream-4-5-hairstyle-v1",
  status: "render_validated",
} as const;

export function isHairstyleRenderProviderCalibrated(providerName: string): boolean {
  return (
    HAIRSTYLE_RENDER_CALIBRATION.status === "render_validated" &&
    providerName === HAIRSTYLE_RENDER_CALIBRATION.providerName
  );
}

/**
 * Objective construction facts, not aesthetic matching rules. These values say
 * what a named cut physically requires/does; they do not claim who looks good
 * in it. Keeping them outside the LLM prevents feasibility labels from being
 * biased toward whichever answer would pass the current user's constraint.
 */
/*
 * 假发维度的回填依据：`docs/research-mens-daily-wig-craft-cn.md`（根仓库，2026-07-29）。
 * 依据强度一律 `reasoned` —— 没有购买样本做实拍对照，行业资料不构成本仓库口径的「实测」。
 *
 * 判据刻意只有两条：
 *   1. 是否遮额 —— 遮额款只缺量感，发片补足即可；露额款要整顶，因为发片补不了发际线。
 *   2. 是否极短露头皮 —— 直接判不可行。
 *
 * 第 2 条比其余部分可信：假发从业者**一致不建议**用假发做寸头类长度（头发极短时头皮成为
 * 视觉焦点，网底与不自然发际线立刻暴露）。这是对卖方不利却被普遍承认的说法，而这个领域
 * 几乎所有可检索内容都由卖家或服务商发布，所以反向利益的证据格外值得采信。
 *
 * 露额款一律给 `full_wig_front_lace` 而非 `full_wig`：完全暴露发际线的造型需要蕾丝前额 +
 * 漂结 + 渐变密度发际线，不是所有价位做得到。`full_wig` 因此当前无标注使用，但它仍是
 * 「被遮额挡住」推出的档位下限（见 rules/wigOptions 取更严一方的逻辑），不是死枚举。
 *
 * 一条标注里表达不了的材质约束：需要烫卷纹理的款式（蓬松纹理烫、自然卷短发）不能用普通
 * 化纤补量 —— 蛋白丝不可烫染、不可近高温，这一档的发片必须是真人发或已烫好的成品。
 */
export const OBJECTIVE_HAIRSTYLE_ATTRIBUTES: readonly ObjectiveHairstyleAttributes[] = [
  // These two entries use the exact deployed catalog names. They must be
  // calibrated independently from their colloquial near-neighbours before a
  // runtime candidate is allowed to request an image preview.
  { canonicalName: "自然短碎盖", aliases: [], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留五到七公分并自然向前覆盖，发梢剪出轻碎层次，刘海落到眉毛附近，两侧和后颈修短但不推出渐变线，不留固定分缝", wigFeasibility: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" }},
  { canonicalName: "圆寸", aliases: [], requiresHairVolume: "low", coversForehead: false , renderDescription: "全头保持一公分左右的极短长度，顶部轮廓顺着头型形成自然圆弧，两侧和后颈柔和收短，不留刘海，额头完全露出", wigFeasibility: { feasible: false, reason: "极短款式头皮成为视觉焦点，网底与发际线藏不住，从业者一致不建议用假发做此类长度", evidenceStrength: "reasoned" }},
  { canonicalName: "微碎盖", aliases: ["短碎盖", "碎盖"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留五到七公分，发梢斜着不齐剪出凌乱层次，刘海盖到眉毛，两侧和后颈剪到一两公分，鬓角自然不推出渐变线", wigFeasibility: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" }},
  { canonicalName: "法式碎盖", aliases: ["法式短碎发"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留六到八公分，细碎刘海垂到眉毛且边缘不齐，两侧和后颈推薄", wigFeasibility: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" }},
  { canonicalName: "纹理前刺", aliases: ["前刺"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留四到五公分，额前头发用发泥往上抓起蓬松，两侧推短，露出额头", wigFeasibility: { feasible: true, minimumTier: "full_wig_front_lace", evidenceStrength: "reasoned" }},
  { canonicalName: "短寸", aliases: ["寸头", "板寸", "圆寸"], requiresHairVolume: "low", coversForehead: false , renderDescription: "全头用推子均匀推到一公分左右，不留刘海，额头完全露出", wigFeasibility: { feasible: false, reason: "极短款式头皮成为视觉焦点，网底与发际线藏不住，从业者一致不建议用假发做此类长度", evidenceStrength: "reasoned" }},
  { canonicalName: "美式渐变短发", aliases: ["渐变短发", "fade"], requiresHairVolume: "low", coversForehead: false , renderDescription: "两侧用推子从耳上极短往上推出明显渐变，顶部留三到四公分，额头露出", wigFeasibility: { feasible: false, reason: "极短款式头皮成为视觉焦点，网底与发际线藏不住，从业者一致不建议用假发做此类长度", evidenceStrength: "reasoned" }},
  { canonicalName: "侧分短发", aliases: ["侧分"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留六到七公分并保持蓬松，在一侧分开，刘海稍微斜盖住额角，鬓角剪薄", wigFeasibility: { feasible: true, minimumTier: "full_wig_front_lace", evidenceStrength: "reasoned" }},
  { canonicalName: "三七侧分", aliases: ["三七分"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留六到七公分并保持蓬松，按三七分开，刘海斜向一侧稍微遮住额角，鬓角剪薄不推光", wigFeasibility: { feasible: true, minimumTier: "full_wig_front_lace", evidenceStrength: "reasoned" }},
  { canonicalName: "大背头", aliases: ["背头", "油头"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留七到八公分，全部头发往后梳理并梳得光滑整齐，额头完全露出，两侧贴头", wigFeasibility: { feasible: true, minimumTier: "full_wig_front_lace", evidenceStrength: "reasoned" }},
  { canonicalName: "飞机头", aliases: [], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留七到八公分，从额前往后上方梳起成饱满的圆弧隆起，发面顺滑不炸开，两侧和后面剪短", wigFeasibility: { feasible: true, minimumTier: "full_wig_front_lace", evidenceStrength: "reasoned" }},
  { canonicalName: "栗子头", aliases: [], requiresHairVolume: "low", coversForehead: true , renderDescription: "两侧和后面推短，顶部留长，刘海直接往前梳下来盖住额头，整体圆润像半个栗子", wigFeasibility: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" }},
  { canonicalName: "法式刘海短发", aliases: ["法式刘海"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留五到六公分，刘海平齐垂到眉毛上方，两侧推短", wigFeasibility: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" }},
  { canonicalName: "韩式逗号刘海", aliases: ["逗号刘海"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "刘海留到眉毛并在一侧弯出逗号形的弧度，额头露出一部分，两侧修到露出耳廓，后颈剪薄", wigFeasibility: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" }},
  { canonicalName: "中分短发", aliases: ["中分"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留到耳朵长度并保持蓬松，从正中分开，两边刘海各自垂到眉毛下方", wigFeasibility: { feasible: true, minimumTier: "full_wig_front_lace", evidenceStrength: "reasoned" }},
  { canonicalName: "自然卷短发", aliases: ["短卷发"], requiresHairVolume: "high", coversForehead: true , renderDescription: "顶部留五到六公分的自然卷，卷发蓬松成团，额前散落几缕卷曲发丝，两侧推短", wigFeasibility: { feasible: true, minimumTier: "volume_patch", caveat: "需要烫卷纹理，发片必须是真人发或已烫好的成品", evidenceStrength: "reasoned" }},
  { canonicalName: "蓬松纹理烫", aliases: ["纹理烫"], requiresHairVolume: "high", coversForehead: true , renderDescription: "顶部留六到七公分烫成大波浪的S形起伏，卷圈比自然卷宽松，用发泥抓出向上的空气感，两侧推短", wigFeasibility: { feasible: true, minimumTier: "volume_patch", caveat: "需要烫卷纹理，发片必须是真人发或已烫好的成品", evidenceStrength: "reasoned" }},
] as const;

function normalized(value: string): string {
  return value
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\-—_·（）()]/g, "")
    .replace(/发型|造型/g, "");
}

export function findObjectiveHairstyleAttributes(
  name: string,
): ObjectiveHairstyleAttributes | null {
  const target = normalized(name);
  return (
    OBJECTIVE_HAIRSTYLE_ATTRIBUTES.find((entry) =>
      [entry.canonicalName, ...entry.aliases].some(
        (alias) => normalized(alias) === target,
      ),
    ) ?? null
  );
}

/**
 * 该款式的假发可行性标注。**未标注、未收录都返回 null**——调用方必须把 null 当
 * 「不可行」，见 `wigFeasibility` 的 fail closed 说明。
 */
export function wigFeasibilityFor(name: string): WigFeasibilityAnnotation | null {
  return findObjectiveHairstyleAttributes(name)?.wigFeasibility ?? null;
}
