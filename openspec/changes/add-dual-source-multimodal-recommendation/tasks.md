## 1. 契约与数据模型

- [ ] 1.1 定义服务端部署快照 manifest、源文件哈希、验证器版本与推荐/对照日志引用；禁止运行时读取 `client/` 路径
- [ ] 1.2 为风格、发型、发型关系、fit-rules、衣柜、资产和供给数据实现“验证通过才构建快照”的单向构建；server 不得手改副本
- [ ] 1.3 定义关系覆盖、fit-rule production、render calibration 三个独立 readiness gate 及 `catalogCoverage` / asset 状态契约
- [ ] 1.4 将旧 `OBJECTIVE_HAIRSTYLE_ATTRIBUTES` 收敛为渲染兼容投影；推荐路径迁移到稳定 `hairstyleId`，不得保留第二份适配/关系事实
- [ ] 1.5 定义共享的双源输入、逐通道结果、领域归一化候选、diff、组装结果和降级状态契约
- [ ] 1.6 为风格、发型和穿搭定义版本化 schema、canonicalizer、diff policy 和数量策略
- [ ] 1.7 增加推荐对照、逐通道运行、曝光、选择、强结果事件及 reviewer 状态的数据模型与迁移
- [ ] 1.8 增加 CatalogGap、AssetGenerationQueue、ConceptCatalogMapping 数据模型与迁移
- [ ] 1.9 将新增表纳入用户删除、人脸同意撤回和不可逆匿名聚合链路

## 2. 双源引擎

- [ ] 2.1 实现 A/B 同输入装配，保证只有 B 接收系统目录和规则上下文
- [ ] 2.2 实现相同 provider/model/参数校验、随机性标记、8–12 秒逐通道超时和并行执行
- [ ] 2.3 实现全部适用召回、紧凑投影、token/byte 预算计量、稳定 ID 完整分批和确定性合并
- [ ] 2.4 实现逐领域归一化、确定性 diff、硬冲突判断和固定候选组装
- [ ] 2.5 实现 A/B/系统目录各类失败的降级矩阵，禁止把 AI 探索标成系统验证
- [ ] 2.6 实现逐阶段、逐领域、逐通道 computation key、缓存复用和失败通道独立重试
- [ ] 2.7 持久化完整版本引用、通道结果、实际曝光、成本、延迟、版本和复用状态

## 3. 领域工具与 Adapter

- [ ] 3.1 实现 `recommend-style-directions`，返回 3 个主推荐和最多 1 个探索方向
- [ ] 3.2 实现 `recommend-hairstyles`，要求已选风格并使用发型领域多模态输入与规则
- [ ] 3.3 扩展 `recommend-wardrobe`，要求已选风格和发型，复用系统衣柜公式/槽位/资产状态
- [ ] 3.4 将三个工具注册到对话 Agent，并禁止 Agent 直接访问 A/B、diff、reviewer 或目录 provider
- [ ] 3.5 为无全身照穿搭实现结构化数据降级和禁止视觉比例断言
- [ ] 3.6 禁止所有推荐 adapter 接收预览图、目标图等生成资产

## 4. Workflow 与选择流程

- [ ] 4.1 把首次分析拆为风格推荐等待点、发型推荐等待点和穿搭推荐等待点
- [ ] 4.2 增加风格选择归属校验，并使选择变化失效下游发型和穿搭 generation
- [ ] 4.3 增加发型选择归属校验，并使选择变化失效下游穿搭 generation
- [ ] 4.4 将实际对外候选及其 source/position 写入 exposure，再返回用户
- [ ] 4.5 将用户选择写入 choice 层，并保留当时的 comparison log/generation 引用
- [ ] 4.6 保持现有预览、方案物化和 GeneratedAsset 生命周期只消费已选择的领域候选

## 5. Reviewer、反馈与资产缺口

- [ ] 5.1 实现高差异异步 reviewer 队列及 `not_required|pending|completed|failed` 状态机
- [ ] 5.2 reviewer 输出固定分歧分类、相关 rule ID 和复审建议，不保存辩论 transcript
- [ ] 5.3 实现保存、槽位替换、明确不喜欢、保存试穿和最终采用等强结果事件
- [ ] 5.4 为目录外概念生成稳定 concept ID，并创建/合并 CatalogGap 与资产生成任务
- [ ] 5.5 用户选择目录缺口时提升资产任务优先级
- [ ] 5.6 实现概念到正式目录/资产的后续映射，同时保持历史推荐快照不可变

## 6. 高层契约测试

- [ ] 6.1 建立三个领域工具共用的 DualSourceRecommendationEngine 契约测试套件
- [ ] 6.2 覆盖同输入隔离、并行、完整分批、无静默截断和确定性合并
- [ ] 6.3 覆盖 diff/组装顺序、候选数量、最多一个探索项、硬冲突和已选风格保留
- [ ] 6.4 覆盖所有单/双通道失败、目录失败、无全身照及超时降级
- [ ] 6.5 覆盖逐通道幂等、独立重试、generation 失效和 reviewer 幂等
- [ ] 6.6 覆盖 comparison/exposure/choice/outcome 持久化与曝光感知采纳统计输入
- [ ] 6.7 覆盖 CatalogGap、资产队列、概念映射、历史不可变与禁止生成图输入
- [ ] 6.8 覆盖账户删除和人脸同意撤回后的可识别引用删除与匿名聚合保留

## 7. 集成验证与发布

- [ ] 7.1 为快照构建、缺失/漂移拒绝、关系覆盖降级、draft rule 零投影、特殊发型排除和未校准渲染跳过添加测试
- [ ] 7.2 增加三个选择等待点、422 前置条件和下游失效的 workflow/route 集成测试
- [ ] 7.3 增加真实多模态 provider 冒烟测试，核对 A/B 同模型参数、schema、延迟和成本记录
- [ ] 7.4 增加目录超过单次上下文预算的完整分批压测
- [ ] 7.5 增加内部 feature flag、分阶段启用、监控与回滚开关
- [ ] 7.6 更新目标 workflow、工具清单、隐私说明和推荐能力文档
- [ ] 7.7 严格校验 OpenSpec，并在提案获批后才开始实现
