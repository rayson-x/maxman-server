## 1. Formal catalog and recommendation safety

- [ ] 1.1 从客户端教研目录核对八项的名称、别名、可观察结构与维护边界。
- [ ] 1.2 为八项加入服务端客观属性：canonical 名称、别名、发量档位、遮额、长度层级和规范渲染描述。
- [ ] 1.3 增加显式中长发/长发意向门槛；默认首轮候选保持短发目录。
- [ ] 1.4 让选择长发方向的任务如实表达留长/维护，而非承诺一次剪发完成。

## 2. Image assets and client contract

- [ ] 2.1 用 Seedream 校准八项规范渲染描述，并记录结构与身份保持结果。
- [ ] 2.2 用 ImageGen 生成 8 × 7 张固定脸型静态参考图，按 canonical id 与 face shape 落盘。
- [ ] 2.3 将 manifest 从 15 × 7 扩展为 23 × 7；逐格验证可读且无缺失。
- [ ] 2.4 更新依赖的客户端参考卡 change，使 registry 和卡片覆盖 23 款，并对长发显示“留长方向”提示。

## 3. Verification

- [ ] 3.1 为属性解析、显式长度意向门槛、发量/遮额约束写测试。
- [ ] 3.2 为 23 × 7 manifest 完整性与图片可读性写校验。
- [ ] 3.3 运行服务端 tests、typecheck、lint/build（按项目现有脚本）和 OpenSpec strict validation。
