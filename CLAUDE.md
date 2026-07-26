<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

---

服务端实现目录。**目标设计与 tool 调用路径见 `docs/target-workflow.md`**（业务流程图 + 内核/接缝划分 + 完整 tool 清单）；
数据模型以 `prisma/schema.prisma` 为准；各变更的决策记录见 `openspec/changes/*/design.md`。
产品级设计（跨端）在上一级 `../docs/` 目录，不在这里维护。
