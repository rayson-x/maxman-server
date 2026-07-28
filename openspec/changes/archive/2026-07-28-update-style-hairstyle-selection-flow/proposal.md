# Change: 风格与发型组合选择先于预览和穿搭

## Why

当前首轮已同时得到风格与发型候选，却在用户选择前为所有发型出图；风格与发型也没有
可验证的对应关系。用户需要先在同一界面选择一个风格—发型组合，再据此获得穿搭建议。

## What Changes

- 首轮每个发型候选必须引用一个首轮提供的风格方向，客户端可按风格展示匹配发型。
- `initial_analysis` 只返回选择数据，不再自动生成所有发型预览图。
- 提供原子化的“选择风格与发型”端点，拒绝不属于所选风格的发型候选。
- 已选组合成为穿搭推荐的唯一上游选择；本变更不引入商品 SKU 或电商链接。

## Impact

- Affected specs: `two-round-style-agent`
- Affected code: 首轮 tool schema、推荐候选持久化、方案选择路由、job 编排
- Affected docs: `docs/target-workflow.md`
