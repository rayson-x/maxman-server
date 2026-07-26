import "dotenv/config";
import { createPrismaClient } from "../lib/prisma.js";

/**
 * **仅供本地测试的风格数据**。不是调研成果，不要用于生产。
 *
 * 为什么需要它：真实风格数据（tasks 0.4）由调研任务产出，目前 `StyleProfileEntry`
 * 为空。数据为空时 S3 会如实返回 `dataReady: false` 且候选为 0，于是 S4/S4′ 无事可做——
 * 整条 onboarding 链路走不到出图那一步，编排层就没法验证。
 *
 * 三道防线确保它不会被误当成真实数据：
 *   1. 所有 id 以 `test-` 开头，`clearTestStyleData()` 可精确清除，不碰真实数据
 *   2. `femaleAppealSource` / `maleSelfAppealSource` 一律写死为 `test_fixture_not_research`,
 *      `confidence` 一律 `low`——任何把它当依据向用户表述的代码路径都会看到这个标记
 *   3. rationale 明说「测试占位」，即便漏进 UI 也一眼可辨
 *
 * 数值取向上刻意做出区分度（正装/休闲、成熟/年轻、高低打理成本各有分布），
 * 这样风格向量的协调性过滤、双审美落差、发量约束过滤都能真的被触发到，
 * 而不是所有条目长得一样导致过滤逻辑空转。
 */

const TEST_SOURCE = "test_fixture_not_research";
const TEST_PREFIX = "test-";

type HairSeed = {
  id: string;
  nameZh: string;
  aliases: string[];
  description: string;
  v: [number, number, number, number]; // formality, maturity, boldness, upkeep
  female: number;
  male: number;
  requiresHairVolume: "low" | "medium" | "high";
  coversForehead: boolean;
  faceShapes: string[];
  estTime: string;
  estCost: string;
};

const HAIRSTYLES: HairSeed[] = [
  {
    id: "test-hair-suisugai",
    nameZh: "微碎盖",
    aliases: ["碎盖", "碎盖头"],
    description: "额前留碎发的短盖头，发尾做少量层次，日常好打理",
    v: [4, 4, 4, 4], female: 9, male: 8,
    requiresHairVolume: "medium", coversForehead: true,
    faceShapes: ["round", "square", "oblong", "oval"],
    estTime: "40 分钟", estCost: "¥40-80",
  },
  {
    id: "test-hair-cuntou",
    nameZh: "寸头",
    aliases: ["板寸", "圆寸"],
    description: "整体推短至 1-2 厘米，露出额头与轮廓，几乎零打理",
    v: [5, 6, 6, 1], female: 6, male: 8,
    requiresHairVolume: "low", coversForehead: false,
    faceShapes: ["oval", "square", "diamond"],
    estTime: "20 分钟", estCost: "¥25-50",
  },
  {
    id: "test-hair-wenliyang",
    nameZh: "纹理烫短发",
    aliases: ["纹理烫", "羊毛卷短发"],
    description: "顶部烫出蓬松纹理增加发量感，两侧收干净",
    v: [4, 5, 6, 7], female: 8, male: 6,
    requiresHairVolume: "low", coversForehead: true,
    faceShapes: ["round", "oblong", "oval", "pear"],
    estTime: "2 小时", estCost: "¥200-400",
  },
  {
    id: "test-hair-sanqifen",
    nameZh: "三七分背头",
    aliases: ["背头", "三七分"],
    description: "侧分向后梳起，用发胶定型，露出额头显精神",
    v: [8, 8, 5, 6], female: 7, male: 7,
    requiresHairVolume: "high", coversForehead: false,
    faceShapes: ["oval", "round", "heart"],
    estTime: "45 分钟", estCost: "¥60-120",
  },
  {
    id: "test-hair-gouliuhai",
    nameZh: "狗啃刘海短发",
    aliases: ["狗啃刘海", "法式刘海"],
    description: "刘海剪出不规则缺口，偏日系松散感，遮盖发际线",
    v: [3, 3, 8, 5], female: 8, male: 5,
    requiresHairVolume: "medium", coversForehead: true,
    faceShapes: ["oblong", "square", "diamond"],
    estTime: "50 分钟", estCost: "¥60-150",
  },
  {
    id: "test-hair-zhongfen",
    nameZh: "中分中长发",
    aliases: ["中分", "韩式中分"],
    description: "中间分缝、长度过耳，需要定期打理造型",
    v: [5, 5, 7, 8], female: 7, male: 6,
    requiresHairVolume: "high", coversForehead: false,
    faceShapes: ["oval", "oblong"],
    estTime: "1 小时", estCost: "¥80-200",
  },
];

type OutfitSeed = {
  id: string;
  nameZh: string;
  description: string;
  v: [number, number, number, number];
  female: number;
  male: number;
  items: { category: string; note: string }[];
  scenes: string[];
  estCost: string;
};

const OUTFITS: OutfitSeed[] = [
  {
    id: "test-outfit-smart-casual",
    nameZh: "简约通勤休闲",
    description: "纯色针织衫 + 直筒休闲裤 + 干净白鞋",
    v: [6, 6, 3, 4], female: 8, male: 7,
    items: [
      { category: "上装", note: "纯色圆领针织衫，藏青或灰" },
      { category: "下装", note: "直筒休闲裤，卡其或深灰" },
      { category: "鞋", note: "简约小白鞋" },
    ],
    scenes: ["日常", "约会", "轻商务"], estCost: "¥400-800",
  },
  {
    id: "test-outfit-street",
    nameZh: "美式复古街头",
    description: "宽松卫衣 + 直筒牛仔 + 高帮帆布鞋",
    v: [2, 3, 7, 3], female: 6, male: 8,
    items: [
      { category: "上装", note: "落肩宽松卫衣，字母或色块" },
      { category: "下装", note: "直筒或微阔牛仔裤" },
      { category: "鞋", note: "高帮帆布鞋或复古跑鞋" },
    ],
    scenes: ["日常", "校园", "朋友聚会"], estCost: "¥300-600",
  },
  {
    id: "test-outfit-business",
    nameZh: "轻正装",
    description: "衬衫 + 西裤 + 德比鞋，不打领带",
    v: [9, 8, 2, 6], female: 8, male: 6,
    items: [
      { category: "上装", note: "白/浅蓝修身衬衫，免烫面料" },
      { category: "下装", note: "深色西裤，九分长度" },
      { category: "鞋", note: "素面德比鞋" },
    ],
    scenes: ["面试", "正式场合", "职场"], estCost: "¥600-1200",
  },
  {
    id: "test-outfit-japanese",
    nameZh: "日系文艺",
    description: "宽松衬衫 + 阔腿裤 + 乐福鞋，低饱和配色",
    v: [5, 4, 5, 5], female: 7, male: 7,
    items: [
      { category: "上装", note: "亚麻或棉质宽松衬衫，米/灰绿" },
      { category: "下装", note: "阔腿或锥形长裤" },
      { category: "鞋", note: "乐福鞋或帆布鞋" },
    ],
    scenes: ["日常", "约会", "看展"], estCost: "¥400-900",
  },
  {
    id: "test-outfit-sport",
    nameZh: "运动机能",
    description: "速干上衣 + 束脚裤 + 跑鞋",
    v: [1, 4, 6, 2], female: 5, male: 8,
    items: [
      { category: "上装", note: "速干短袖或紧身长袖" },
      { category: "下装", note: "束脚运动长裤" },
      { category: "鞋", note: "缓震跑鞋" },
    ],
    scenes: ["健身", "日常通勤"], estCost: "¥300-700",
  },
];

const prisma = createPrismaClient();

/** 精确清除测试数据，不影响真实数据 */
export async function clearTestStyleData(): Promise<number> {
  const r = await prisma.styleProfileEntry.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
  return r.count;
}

try {
  if (process.argv.includes("--clear")) {
    const n = await clearTestStyleData();
    console.log(`已清除测试风格数据 ${n} 条（真实数据未受影响）`);
    await prisma.$disconnect();
    process.exit(0);
  }

  const cleared = await clearTestStyleData();
  if (cleared > 0) console.log(`清除旧测试数据 ${cleared} 条`);

  for (const h of HAIRSTYLES) {
    await prisma.styleProfileEntry.create({
      data: {
        id: h.id,
        kind: "hairstyle",
        nameZh: h.nameZh,
        aliases: h.aliases,
        description: h.description,
        formality: h.v[0], maturity: h.v[1], boldness: h.v[2], upkeep: h.v[3],
        femaleAppealScore: h.female,
        femaleAppealSource: TEST_SOURCE,
        femaleAppealConfidence: "low",
        femaleAppealRationale: "测试占位数据，非调研结论，不可作为向用户表述的依据",
        maleSelfAppealScore: h.male,
        maleSelfAppealSource: TEST_SOURCE,
        maleSelfAppealConfidence: "low",
        maleSelfAppealRationale: "测试占位数据，非调研结论",
        requiresHairVolume: h.requiresHairVolume,
        coversForehead: h.coversForehead,
        suitableFaceShapes: h.faceShapes,
        suitableBodyTypes: [],
        suitableScenes: ["日常"],
        estTime: h.estTime,
        estCostRange: h.estCost,
        notes: "⚠ 测试数据",
        isRecommended: true,
      },
    });
  }

  for (const o of OUTFITS) {
    await prisma.styleProfileEntry.create({
      data: {
        id: o.id,
        kind: "outfit_combo",
        nameZh: o.nameZh,
        aliases: [],
        description: o.description,
        formality: o.v[0], maturity: o.v[1], boldness: o.v[2], upkeep: o.v[3],
        femaleAppealScore: o.female,
        femaleAppealSource: TEST_SOURCE,
        femaleAppealConfidence: "low",
        femaleAppealRationale: "测试占位数据，非调研结论，不可作为向用户表述的依据",
        maleSelfAppealScore: o.male,
        maleSelfAppealSource: TEST_SOURCE,
        maleSelfAppealConfidence: "low",
        maleSelfAppealRationale: "测试占位数据，非调研结论",
        suitableFaceShapes: [],
        suitableBodyTypes: [],
        suitableScenes: o.scenes,
        items: o.items,
        estCostRange: o.estCost,
        notes: "⚠ 测试数据",
        isRecommended: true,
      },
    });
  }

  const hair = await prisma.styleProfileEntry.count({ where: { kind: "hairstyle" } });
  const outfit = await prisma.styleProfileEntry.count({ where: { kind: "outfit_combo" } });
  console.log(`\n已写入测试风格数据：发型 ${hair} 条 / 穿搭 ${outfit} 条`);
  console.log(`所有条目 source=${TEST_SOURCE}、confidence=low，id 前缀 ${TEST_PREFIX}`);
  console.log(`清除：npx tsx src/scripts/seed-test-style-data.ts --clear`);
} finally {
  await prisma.$disconnect();
}
