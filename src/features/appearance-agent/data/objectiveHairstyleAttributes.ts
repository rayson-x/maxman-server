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
};

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
export const OBJECTIVE_HAIRSTYLE_ATTRIBUTES: readonly ObjectiveHairstyleAttributes[] = [
  // These two entries use the exact deployed catalog names. They must be
  // calibrated independently from their colloquial near-neighbours before a
  // runtime candidate is allowed to request an image preview.
  { canonicalName: "自然短碎盖", aliases: [], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留五到七公分并自然向前覆盖，发梢剪出轻碎层次，刘海落到眉毛附近，两侧和后颈修短但不推出渐变线，不留固定分缝"},
  { canonicalName: "圆寸", aliases: [], requiresHairVolume: "low", coversForehead: false , renderDescription: "全头保持一公分左右的极短长度，顶部轮廓顺着头型形成自然圆弧，两侧和后颈柔和收短，不留刘海，额头完全露出"},
  { canonicalName: "微碎盖", aliases: ["短碎盖", "碎盖"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留五到七公分，发梢斜着不齐剪出凌乱层次，刘海盖到眉毛，两侧和后颈剪到一两公分，鬓角自然不推出渐变线"},
  { canonicalName: "法式碎盖", aliases: ["法式短碎发"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留六到八公分，细碎刘海垂到眉毛且边缘不齐，两侧和后颈推薄"},
  { canonicalName: "纹理前刺", aliases: ["前刺"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留四到五公分，额前头发用发泥往上抓起蓬松，两侧推短，露出额头"},
  { canonicalName: "短寸", aliases: ["寸头", "板寸", "圆寸"], requiresHairVolume: "low", coversForehead: false , renderDescription: "全头用推子均匀推到一公分左右，不留刘海，额头完全露出"},
  { canonicalName: "美式渐变短发", aliases: ["渐变短发", "fade"], requiresHairVolume: "low", coversForehead: false , renderDescription: "两侧用推子从耳上极短往上推出明显渐变，顶部留三到四公分，额头露出"},
  { canonicalName: "侧分短发", aliases: ["侧分"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留六到七公分并保持蓬松，在一侧分开，刘海稍微斜盖住额角，鬓角剪薄"},
  { canonicalName: "三七侧分", aliases: ["三七分"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留六到七公分并保持蓬松，按三七分开，刘海斜向一侧稍微遮住额角，鬓角剪薄不推光"},
  { canonicalName: "大背头", aliases: ["背头", "油头"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留七到八公分，全部头发往后梳理并梳得光滑整齐，额头完全露出，两侧贴头"},
  { canonicalName: "飞机头", aliases: [], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留七到八公分，从额前往后上方梳起成饱满的圆弧隆起，发面顺滑不炸开，两侧和后面剪短"},
  { canonicalName: "栗子头", aliases: [], requiresHairVolume: "low", coversForehead: true , renderDescription: "两侧和后面推短，顶部留长，刘海直接往前梳下来盖住额头，整体圆润像半个栗子"},
  { canonicalName: "法式刘海短发", aliases: ["法式刘海"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "顶部留五到六公分，刘海平齐垂到眉毛上方，两侧推短"},
  { canonicalName: "韩式逗号刘海", aliases: ["逗号刘海"], requiresHairVolume: "medium", coversForehead: true , renderDescription: "刘海留到眉毛并在一侧弯出逗号形的弧度，额头露出一部分，两侧修到露出耳廓，后颈剪薄"},
  { canonicalName: "中分短发", aliases: ["中分"], requiresHairVolume: "medium", coversForehead: false , renderDescription: "顶部留到耳朵长度并保持蓬松，从正中分开，两边刘海各自垂到眉毛下方"},
  { canonicalName: "自然卷短发", aliases: ["短卷发"], requiresHairVolume: "high", coversForehead: true , renderDescription: "顶部留五到六公分的自然卷，卷发蓬松成团，额前散落几缕卷曲发丝，两侧推短"},
  { canonicalName: "蓬松纹理烫", aliases: ["纹理烫"], requiresHairVolume: "high", coversForehead: true , renderDescription: "顶部留六到七公分烫成大波浪的S形起伏，卷圈比自然卷宽松，用发泥抓出向上的空气感，两侧推短"},
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
