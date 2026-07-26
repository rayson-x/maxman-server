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
 *   - 生产环境 **fail closed**：必须 `passed`
 *   - 本地与内部测试：接受 `pending`，因为审核 provider 缺位
 *   - **任何环境都不接受 `rejected`**
 *
 * 放行 `pending` 不等于假装审核过：S1 会如实写下 `photoVerdicts: deferred_no_provider`，
 * 上游据此知道这一项未校验。
 */
export function acceptedPhotoModerationStatuses(
  /** 显式传入便于测试两个分支；`env` 在模块加载时求值，改 process.env 影响不到它 */
  isProduction: boolean = env.server.isProduction,
): ModerationStatus[] {
  return isProduction ? ["passed"] : ["passed", "pending"];
}

/** Prisma where 片段，供各处直接展开使用 */
export function photoModerationWhere(): { moderationStatus: { in: ModerationStatus[] } } {
  return { moderationStatus: { in: acceptedPhotoModerationStatuses() } };
}
