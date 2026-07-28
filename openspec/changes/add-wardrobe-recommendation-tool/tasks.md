## 1. 目录构建与契约

- [x] 1.1 为系统衣柜、风格公式、资产和供给映射定义构建期结构、稳定 ID 与引用校验
- [x] 1.2 编写内容构建脚本，产出版本化服务端只读目录快照；禁止运行时读取 `client/` 相对路径
- [ ] 1.3 为断链、重复 ID、空槽位、无效资产状态和 SKU 引用写失败测试

## 2. JSON 目录与应用层

- [x] 2.1 在 `RecommendationApplication` 增加 `recommendWardrobe`；系统目录与 bundle 不新增数据库表
- [x] 2.3 实现风格 → 公式 → 槽位 → 单品的确定性检索与软排序
- [x] 2.4 实现结构化 bundle：1 主搭、2 备选、每槽 3–5 个替换项、资产状态和可选供给信息
- [x] 2.5 第一版采用目录公式解释，不接入 LLM；因此没有未知 ID 可被 LLM 引入
- [ ] 2.5 预留仅强事件的反馈契约；本版本不新增反馈持久化

## 3. Agent 与固定流程接线

- [x] 3.1 为 Appearance Agent 增加唯一 `recommend-wardrobe` tool；禁止其直接访问目录/provider
- [x] 3.2 在选定风格与发型后由 job/workflow 调用同一应用入口
- [x] 3.3 暴露读取系统衣柜 bundle 的方案端点；确认 look/单品及反馈表留待下一变更
- [ ] 3.4 仅当所有用于真人换装的服装单品均有 public URL 时开放试穿；否则明确展示目录图状态

## 4. 验证

- [x] 4.1 单元测试：所选风格必在结果、相同输入得到同一 bundle、软适配不拦截、无效 ID 被拒绝
- [ ] 4.2 集成测试：workflow 与 Agent 对相同输入得到同一 bundle；用户选择能影响下一次排序
- [~] 4.3 已运行 typecheck、聚焦测试和完整测试；完整测试因本机 PostgreSQL 未启动而有 11 个既有 DB 集成测试失败。本变更没有 Prisma 迁移。
- [x] 4.4 `openspec validate add-wardrobe-recommendation-tool --strict`
