import type { PrismaClient } from "../generated/prisma/client.js";
import { createPrismaClient } from "../lib/prisma.js";
import { createQueues, type QueueBundle } from "../lib/queues.js";
import { setActiveTaskLedger } from "../lib/taskLedger.js";
import { createPrismaTaskLedger } from "../lib/prismaTaskLedger.js";
import {
  getVisionAnalysisProvider,
  getImageEditProvider,
  getClothingSwapProvider,
  getTextToImageProvider,
  getTextPlanningProvider,
  getFreeRecommendationProvider,
  getAdversarialReviewProvider,
  getStyleRecommendationProvider,
  getHairstyleRecommendationProvider,
  getOutfitRecommendationProvider,
  getPlanMaterializationProvider,
  getWeatherContextService,
} from "../features/appearance-agent/composition.js";
import type { VisionAnalysisProvider } from "../features/appearance-agent/providers/vision/types.js";
import type { ImageEditProvider } from "../features/appearance-agent/providers/imageEdit/types.js";
import type { ClothingSwapProvider } from "../features/appearance-agent/providers/clothing/types.js";
import type { TextToImageProvider } from "../features/appearance-agent/providers/textToImage/types.js";
import type { TextPlanningProvider } from "../features/appearance-agent/providers/textPlanning/types.js";
import type { FreeRecommendationProvider } from "../features/appearance-agent/providers/freeRecommendation/types.js";
import type { AdversarialReviewProvider } from "../features/appearance-agent/providers/adversarialReview/types.js";
import type { StyleRecommendationProvider } from "../features/appearance-agent/providers/styleRecommendation/types.js";
import type { PlanMaterializationProvider } from "../features/appearance-agent/providers/planMaterialization/types.js";
import type { WeatherContextService } from "../features/appearance-agent/weather/types.js";

/**
 * 应用级组装根（tasks 1.6）。
 *
 * 这是**唯一**构造基础设施与 provider 实例的地方。所有下游（route handler、
 * service、step、worker）都以显式参数接收依赖，不 import 全局单例——这样：
 *   ① 测试可以注入独立的 Prisma 实例或事务包裹的 client，不需要打全局 mock
 *   ② 换供应商只改 composition，业务代码零改动（design.md 决策 1）
 *   ③ 依赖关系在类型上可见，不是隐藏在 import 里
 *
 * provider 部分委托给 features/appearance-agent/composition.ts —— 那一层负责
 * 读 ACTIVE_*_PROVIDER 环境变量选具体供应商，本层只负责把结果装进容器。
 */
export type AppContainer = {
  prisma: PrismaClient;
  queues: QueueBundle;
  providers: {
    vision: VisionAnalysisProvider;
    imageEdit: ImageEditProvider;
    clothingSwap: ClothingSwapProvider;
    textToImage: TextToImageProvider;
    textPlanning: TextPlanningProvider;
    freeRecommendation: FreeRecommendationProvider;
    adversarialReview: AdversarialReviewProvider;
    styleRecommendation: StyleRecommendationProvider;
    hairstyleRecommendation: ReturnType<typeof getHairstyleRecommendationProvider>;
    outfitRecommendation: ReturnType<typeof getOutfitRecommendationProvider>;
    planMaterialization: PlanMaterializationProvider;
  };
  /**
   * 城市级天气上下文。`withProviders: false` 时为 undefined——
   * 调用方必须按"拿不到就降级"处理，见 jobOrchestrator 的 resolveWeatherContext。
   */
  weatherContext?: WeatherContextService;
  shutdown: () => Promise<void>;
};

export type ContainerOptions = {
  /** 只需要 DB 的场景（如迁移脚本、种子数据）可跳过队列与 provider 构造 */
  withQueues?: boolean;
  withProviders?: boolean;
  /** 测试可注入替身 */
  prisma?: PrismaClient;
};

export function createContainer(opts: ContainerOptions = {}): AppContainer {
  const { withQueues = true, withProviders = true } = opts;

  const prisma = opts.prisma ?? createPrismaClient();

  // tasks 10.4：把供应商调用账本从文件切到 Postgres。
  // 实质收益是**跨进程可见**——API 进程提交的任务，worker 进程能查到；
  // 一个 worker 崩了，另一个能凭 callId 接管轮询。文件版在多进程下各写各的文件，
  // 恢复能力形同虚设。测试脚本不经过组装根，仍用默认的文件版，零配置可跑。
  setActiveTaskLedger(createPrismaTaskLedger(prisma));

  const queues = withQueues ? createQueues() : ({ queues: {}, connection: null, close: async () => {} } as unknown as QueueBundle);

  // provider 是惰性构造的（composition 内部 ??= 缓存），这里只在需要时触发。
  // 不需要 provider 的场景（纯 CRUD 测试）不应因为缺 API key 而启动失败。
  const providers = withProviders
    ? {
        vision: getVisionAnalysisProvider(),
        imageEdit: getImageEditProvider(),
        clothingSwap: getClothingSwapProvider(),
        textToImage: getTextToImageProvider(),
        textPlanning: getTextPlanningProvider(),
        freeRecommendation: getFreeRecommendationProvider(),
        adversarialReview: getAdversarialReviewProvider(),
        styleRecommendation: getStyleRecommendationProvider(),
        hairstyleRecommendation: getHairstyleRecommendationProvider(),
        outfitRecommendation: getOutfitRecommendationProvider(),
        planMaterialization: getPlanMaterializationProvider(),
      }
    : ({} as AppContainer["providers"]);

  return {
    prisma,
    queues,
    providers,
    // 与 providers 同一个门控：build() 会打外部 HTTP（Open-Meteo），
    // 纯 CRUD 测试不该因此产生网络依赖。
    weatherContext: withProviders ? getWeatherContextService() : undefined,
    shutdown: async () => {
      await queues.close();
      await prisma.$disconnect();
    },
  };
}
