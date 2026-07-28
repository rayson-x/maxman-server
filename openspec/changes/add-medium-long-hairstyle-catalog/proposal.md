# Change: 扩展中长发正式推荐目录

## Why

客户端教研目录 `client/data/style-annotation/hairstyles-cn.json` 已有 27 条发型，其中包含中长发与长发方向；但服务端的正式、可校验发型表只有 15 款短发。首轮 Agent 因此无法返回中长发，按脸型参考图也只覆盖短发。

## What Changes

- 将 8 个已有编辑定义、非特殊候选纳入服务端正式发型目录：四六纹理侧背、港风中长纹理、中长自然分层、短狼尾、长狼尾、披肩直发、披肩波浪发、半扎发。
- 为每项补全规范渲染描述、所需发量、遮额属性与长度层级，令推荐过滤、渲染指令和图像校准使用同一权威条目。
- 中长/长发候选只在用户明确表达留长、尝试中长发或点选该目录方向时进入首轮候选；默认短发流程不得把它们当作可立即完成的剪发建议。
- 为扩展后的 23 款正式目录建立 `7 face shapes × 23 hairstyles` 静态示例覆盖，并让客户端参考卡按 canonical 名称读取。

## Impact

- Affected specs: `style-recommendation`（新增）
- Affected code: `objectiveHairstyleAttributes`、推荐约束与 provider prompt、发型校准脚本、脸型×发型素材 manifest
- Dependent client change: `client/openspec/changes/add-face-shape-hairstyle-reference-cards`
