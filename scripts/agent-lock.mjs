#!/usr/bin/env node
/**
 * 单实例推进锁（lease 租约模式）。
 *
 * 目的：确保任何时刻只有一个 agent 在推进 openspec 实施，防止
 *   ① 定时任务重复唤起 agent 导致重复实施
 *   ② agent 因 token 额度耗尽/session 崩溃而静默死亡后，锁永久占用
 *
 * 为什么落磁盘：CronCreate 的定时任务是 session 级的，session 退出即消失。
 * 锁状态必须在进程外持久化，这样新 session 起来能读到"上一个 agent 干到哪了"。
 *
 * 为什么用租约而不是纯互斥锁：agent 可能被强杀（额度耗尽、用户中断），没有机会
 * 释放锁。纯互斥锁会永久死锁。租约靠心跳续期，agent 死了租约自然过期，别人可接管。
 *
 * 用法：
 *   node scripts/agent-lock.mjs acquire <holder> [task]   → 抢锁，成功 exit 0，被占 exit 1
 *   node scripts/agent-lock.mjs heartbeat <holder> [task] → 续租 + 更新当前任务
 *   node scripts/agent-lock.mjs release <holder>          → 主动释放
 *   node scripts/agent-lock.mjs status                    → 输出 JSON 状态
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = join(SERVER_DIR, ".agent-lock.json");

/**
 * 租约时长必须 > 定时任务间隔（10 分钟），否则一个正在正常工作的 agent
 * 会在两次心跳之间被误判为已死而被抢锁。15 分钟留了 1.5 倍余量。
 */
const LEASE_SECONDS = 15 * 60;

function readLock() {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
  } catch {
    // 文件损坏（例如上次写入时进程被杀）视为无锁，允许接管
    return null;
  }
}

function writeLock(data) {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  writeFileSync(LOCK_PATH, JSON.stringify(data, null, 2));
}

function ageSeconds(lock) {
  if (!lock?.heartbeatAt) return Infinity;
  const parsed = new Date(lock.heartbeatAt).getTime();
  if (Number.isNaN(parsed)) return Infinity;
  return (Date.now() - parsed) / 1000;
}

/**
 * 判定租约是否已失效。
 *
 * 除了正常的"心跳超过租约时长"，还要防一类死锁：心跳时间戳落在**未来**
 * （时钟偏移、文件被手工编辑、跨时区写入错误）。此时 age 为负，朴素比较会
 * 判定为永远新鲜 → 锁永不过期 → 永久死锁。负 age 一律视为不可信，判为失效。
 */
function isStale(lock) {
  const age = ageSeconds(lock);
  if (age < 0) return true;
  return age > (lock?.leaseSeconds ?? LEASE_SECONDS);
}

const [cmd, holder, ...taskParts] = process.argv.slice(2);
const task = taskParts.join(" ") || undefined;
const now = new Date().toISOString();

switch (cmd) {
  case "acquire": {
    if (!holder) {
      console.error("acquire 需要 <holder> 参数");
      process.exit(2);
    }
    const lock = readLock();
    if (lock && lock.holder !== holder && !isStale(lock)) {
      console.log(
        JSON.stringify({
          acquired: false,
          reason: "held_by_other",
          holder: lock.holder,
          heartbeatAgeSeconds: Math.round(ageSeconds(lock)),
          currentTask: lock.currentTask ?? null,
        }),
      );
      process.exit(1);
    }
    const takeover = Boolean(lock && lock.holder !== holder && isStale(lock));
    writeLock({
      holder,
      acquiredAt: lock?.holder === holder ? lock.acquiredAt : now,
      heartbeatAt: now,
      currentTask: task ?? lock?.currentTask ?? null,
      leaseSeconds: LEASE_SECONDS,
      // 保留上一个持有者的最后状态，方便接管者知道进度断在哪
      tookOverFrom: takeover
        ? { holder: lock.holder, lastTask: lock.currentTask ?? null, lastHeartbeatAt: lock.heartbeatAt }
        : undefined,
    });
    console.log(JSON.stringify({ acquired: true, holder, takeover, tookOverFrom: takeover ? lock.holder : null }));
    process.exit(0);
  }

  case "heartbeat": {
    const lock = readLock();
    if (!lock) {
      console.log(JSON.stringify({ ok: false, reason: "no_lock" }));
      process.exit(1);
    }
    if (lock.holder !== holder) {
      console.log(JSON.stringify({ ok: false, reason: "not_holder", holder: lock.holder }));
      process.exit(1);
    }
    writeLock({ ...lock, heartbeatAt: now, currentTask: task ?? lock.currentTask });
    console.log(JSON.stringify({ ok: true, holder, currentTask: task ?? lock.currentTask }));
    process.exit(0);
  }

  case "release": {
    const lock = readLock();
    if (lock && lock.holder !== holder) {
      console.log(JSON.stringify({ ok: false, reason: "not_holder", holder: lock.holder }));
      process.exit(1);
    }
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
    console.log(JSON.stringify({ ok: true, released: true }));
    process.exit(0);
  }

  case "status": {
    const lock = readLock();
    if (!lock) {
      console.log(JSON.stringify({ held: false, free: true }));
      process.exit(0);
    }
    const stale = isStale(lock);
    console.log(
      JSON.stringify({
        held: !stale,
        free: stale,
        stale,
        holder: lock.holder,
        currentTask: lock.currentTask ?? null,
        heartbeatAgeSeconds: Math.round(ageSeconds(lock)),
        leaseSeconds: lock.leaseSeconds ?? LEASE_SECONDS,
        acquiredAt: lock.acquiredAt,
      }),
    );
    process.exit(0);
  }

  default:
    console.error("用法: agent-lock.mjs <acquire|heartbeat|release|status> [holder] [task]");
    process.exit(2);
}
