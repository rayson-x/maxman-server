import { env } from "../config/env.js";
import type { ModerationStatus } from "../generated/prisma/enums.js";

/**
 * 照片审核门槛的**单一判定处**。
 *
 * 为什么要收成一处：这个门槛此前硬编码在 5 个地方（readiness 校验、编排器取照片、
 * S2、S4、进度核验、阶段推进）。图片内容审核 provider 当前搁置，
 * 没有任何东西会把 `pending` 置为 `passed`，于是每一处都成了硬阻塞；
 * 而分散修改必然漏掉一两处，表现为「路由放行、某个 step 说找不到照片」
 * 这种自相矛盾的失败——实测连踩两次。
 *
 * 口径（对应 spec §9 的 fallback 表）：
 *   - 默认 **fail closed**：必须 `passed`
 *   - 只有显式设置 `ALLOW_PENDING_MODERATION=1` 才接受 `pending`
 *   - **任何环境都不接受 `rejected`**
 *
 * 为什么用显式开关而不是 `isProduction` 取反：`isProduction` 来自
 * `NODE_ENV === "production"`，而 `NODE_ENV` 既不在 `.env.example` 里、
 * 也没有任何启动脚本保证它被设上。运维照 `.env.example` 填完变量上线，
 * 得到的是 `isProduction=false` → 放行 `pending`。而审核 provider 当前搁置，
 * 意味着每张照片永远是 `pending`——人脸内容审核在生产完全缺位，且没有任何
 * 报错提示这件事发生了。漏配置必须落在安全的那一侧，所以放宽需要动作，
 * 收紧是默认。
 *
 * 放行 `pending` 不等于假装审核过：S1 会如实写下 `photoVerdicts: deferred_no_provider`，
 * 上游据此知道这一项未校验。
 */
export function acceptedPhotoModerationStatuses(
  /** 显式传入便于测试两个分支；`env` 在模块加载时求值，改 process.env 影响不到它 */
  allowPending: boolean = env.server.allowPendingModeration,
): ModerationStatus[] {
  return allowPending ? ["passed", "pending"] : ["passed"];
}

/** Prisma where 片段，供各处直接展开使用 */
export function photoModerationWhere(): { moderationStatus: { in: ModerationStatus[] } } {
  return { moderationStatus: { in: acceptedPhotoModerationStatuses() } };
}
