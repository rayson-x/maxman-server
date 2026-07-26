#!/usr/bin/env node
/**
 * 统计服务端 openspec 实施进度，供定时任务判断是否还需要唤起 agent。
 *
 * 输出 JSON：{ complete, total, done, deferred, delegated, remaining, nextTasks[] }
 *
 * 复选框语义（与 tasks.md 的图例一致）：
 *   [ ] 未做      → 计入 remaining
 *   [x] 已完成
 *   [~] 有意搁置  → 不计入 remaining（已知并有意为之，不该反复唤起 agent 去做）
 *   [→] 已委派    → 不计入 remaining（他人负责）
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES_DIR = join(SERVER_DIR, "openspec", "changes");

function collectActiveChanges() {
  if (!existsSync(CHANGES_DIR)) return [];
  return readdirSync(CHANGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "archive")
    .map((d) => d.name);
}

const CHECKBOX = /^\s*-\s*\[([ x~→])\]\s*(.+)$/;

function parseTasks(changeId) {
  const path = join(CHANGES_DIR, changeId, "tasks.md");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").split("\n");
  const counts = { total: 0, done: 0, deferred: 0, delegated: 0, remaining: 0 };
  const nextTasks = [];
  for (const line of lines) {
    const m = line.match(CHECKBOX);
    if (!m) continue;
    const [, mark, text] = m;
    counts.total += 1;
    if (mark === "x") counts.done += 1;
    else if (mark === "~") counts.deferred += 1;
    else if (mark === "→") counts.delegated += 1;
    else {
      counts.remaining += 1;
      if (nextTasks.length < 5) nextTasks.push(text.trim().slice(0, 120));
    }
  }
  return { changeId, ...counts, nextTasks };
}

const changes = collectActiveChanges().map(parseTasks).filter(Boolean);

const agg = changes.reduce(
  (a, c) => ({
    total: a.total + c.total,
    done: a.done + c.done,
    deferred: a.deferred + c.deferred,
    delegated: a.delegated + c.delegated,
    remaining: a.remaining + c.remaining,
  }),
  { total: 0, done: 0, deferred: 0, delegated: 0, remaining: 0 },
);

console.log(
  JSON.stringify(
    {
      complete: agg.remaining === 0,
      ...agg,
      // 只列真正还需要做的，供 agent 直接接着干
      nextTasks: changes.flatMap((c) => c.nextTasks.map((t) => `[${c.changeId}] ${t}`)).slice(0, 8),
      perChange: changes.map((c) => ({ changeId: c.changeId, remaining: c.remaining, done: c.done, total: c.total })),
    },
    null,
    2,
  ),
);
