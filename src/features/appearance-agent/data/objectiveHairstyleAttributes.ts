import type { HairVolumeRequirement } from "../rules/hairConstraints.js";

export type ObjectiveHairstyleAttributes = {
  canonicalName: string;
  aliases: readonly string[];
  requiresHairVolume: HairVolumeRequirement;
  coversForehead: boolean;
};

/**
 * Objective construction facts, not aesthetic matching rules. These values say
 * what a named cut physically requires/does; they do not claim who looks good
 * in it. Keeping them outside the LLM prevents feasibility labels from being
 * biased toward whichever answer would pass the current user's constraint.
 */
export const OBJECTIVE_HAIRSTYLE_ATTRIBUTES: readonly ObjectiveHairstyleAttributes[] = [
  { canonicalName: "微碎盖", aliases: ["短碎盖", "碎盖"], requiresHairVolume: "medium", coversForehead: true },
  { canonicalName: "法式碎盖", aliases: ["法式短碎发"], requiresHairVolume: "medium", coversForehead: true },
  { canonicalName: "纹理前刺", aliases: ["前刺"], requiresHairVolume: "medium", coversForehead: false },
  { canonicalName: "短寸", aliases: ["寸头", "板寸", "圆寸"], requiresHairVolume: "low", coversForehead: false },
  { canonicalName: "美式渐变短发", aliases: ["渐变短发", "fade"], requiresHairVolume: "low", coversForehead: false },
  { canonicalName: "侧分短发", aliases: ["侧分"], requiresHairVolume: "medium", coversForehead: false },
  { canonicalName: "三七侧分", aliases: ["三七分"], requiresHairVolume: "medium", coversForehead: false },
  { canonicalName: "大背头", aliases: ["背头", "油头"], requiresHairVolume: "medium", coversForehead: false },
  { canonicalName: "飞机头", aliases: [], requiresHairVolume: "medium", coversForehead: false },
  { canonicalName: "栗子头", aliases: [], requiresHairVolume: "low", coversForehead: true },
  { canonicalName: "法式刘海短发", aliases: ["法式刘海"], requiresHairVolume: "medium", coversForehead: true },
  { canonicalName: "韩式逗号刘海", aliases: ["逗号刘海"], requiresHairVolume: "medium", coversForehead: true },
  { canonicalName: "中分短发", aliases: ["中分"], requiresHairVolume: "medium", coversForehead: false },
  { canonicalName: "自然卷短发", aliases: ["短卷发"], requiresHairVolume: "high", coversForehead: true },
  { canonicalName: "蓬松纹理烫", aliases: ["纹理烫"], requiresHairVolume: "high", coversForehead: true },
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
