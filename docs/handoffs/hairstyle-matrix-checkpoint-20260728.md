# BetterMeet 发型矩阵 checkpoint（2026-07-28）

## 接手目标

继续补齐「脸型 × 发型」展示矩阵：扩展中长/长发发型，同时维持已建立的统一模特和构图标准。用户之后会继续提供真实网红图作为发型结构参考；这些参考图只能用于校准结构，不能直接作为产品展示素材。

### 硬性完成标准（用户明确确认）

**客户端发型库的 27 款发型必须全部进入展示矩阵，并为每一款生成 7 个脸型版本。最终必须是 7 × 27 = 189 张正式效果图。**

- 27 款的唯一权威名单是 `client/data/style-annotation/hairstyles-cn.json`，不要以当前 matrix 的 20 个临时 ID 为范围。
- 特殊候选（贴头辫、locs）也计入 27；它们只是推荐层面的“非默认”，不是矩阵覆盖层面的豁免。
- 先建立 **客户端 27 个 ID → 矩阵卡片 ID** 的一对一映射。一个矩阵卡片不能同时冒充两条客户端定义（例如板寸与圆寸、低马尾与高马尾、低丸子与高丸子）。
- 每个映射必须有 7 个存在的正式 PNG，均为 1024×1536 的完整头肩构图，并经过页面验收。若旧 20 款的名称/结构不能严谨对应客户端条目，应新增或替换卡片，而不是硬凑数量。

## 已完成（当前工作树为准）

- 矩阵位置：`server/benchmark-assets/face-shape-hairstyle-matrix-20260727/`。
- `models-v2/` 是唯一允许用于新生成的 7 张底图（oval、round、square、oblong、heart、diamond、pear）。每张都是完整正脸、下巴、颈部和双肩的 1024×1536（2:3）棚拍图。
- `asset-spec.md` 定义了生成、验收和归档规则。不要用裁切、手工拼脸或旧图拉伸修复；始终直接用相应的 `models-v2/<face>.png` 做 identity-preserve 编辑。
- 现有 `matrix-manifest.json` 的 20 个款式均已完整：20 styles × 7 faces；尺寸审计为 **PASS，所有正式图均 1024×1536**。这只是迁移中间状态，**不满足新的 27 × 7 完成标准**。
- 已重做并发布的样式（旧图均以可恢复方式移动到 `quality-review/pre-v3-effect/<style>/`，新候选和联系表保留在 `quality-review/direct-imagegen-samples/<style>-v3/`）：
  - `micro-part-bowl-fringe`（前置微分碎盖，来自 Levi 实拍结构校准）
  - `medium-natural-layers`（中长自然分层）
  - `french-textured-fringe`、`textured-front-spikes`、`buzz-cut`、`american-fade`、`soft-side-part`
  - `three-seven-side-part`、`slick-back`、`quiff`、`chestnut-cut`、`french-fringe-short`、`comma-fringe`、`center-part`、`natural-curly-crop`、`textured-perm`
  - `short-wolf-tail`、`long-wolf-tail`、`dragon-strand-side-back`。
- 用户此前指出圆脸/方脸/梨形脸会放大到看不到下巴、脸会变形。最新抽查覆盖 oval、round、square、pear，问题当前未复现。

## 已验证

- 正式页面：`server/benchmark-assets/face-shape-hairstyle-matrix-20260727/index.html`
- 最新整页截图：`/tmp/hairstyle-matrix-v6.png`
- 圆/方/梨三脸型并列抽查：`/tmp/hairstyle-matrix-face-audit-v6.png`
- 页面和尺寸均已核查；接手时仍应刷新本地 `file://` 页面、切换 7 个脸型标签后复查。

## 已暂停的工作

- `港风中长纹理`（建议新 ID：`medium-relaxed-texture`）生成批次已主动终止。没有把该批次的输出拷贝进项目，也没有修改 manifest/index。不要假设生成目录中的残留是完整或可发布候选。

## 下一步（优先级）

1. 从 `hairstyles-cn.json` 导出 27 个 ID，与当前 20 个矩阵卡片建立显式一对一 mapping 表。先找出可保留映射、结构不等价需重做、和尚未生成的客户端条目。最终 mapping 表必须恰有 27 个源 ID 和 27 个不同矩阵卡片。
2. 优先补齐缺口较大的中长/长发与固定发型：`medium-relaxed-texture`、`four-six-side-sweep`、`shoulder-straight`、`shoulder-wave`、`low-ponytail`、`high-ponytail`、`high-bun`、`low-bun`、`half-up`、`free-small-braids`、`cornrows-special`、`locs-special`；同时按 mapping 审查短发项是否有一对多偷换（如板寸/圆寸）。
3. 每增加或替换一个样式，都生成 7 张（7 个脸型），放入：
   - 正式：`effects/<styleId>/<face>.png`
   - 候选：`quality-review/direct-imagegen-samples/<styleId>-v1/`
   - 旧版（如有）：`quality-review/pre-vN-effect/<styleId>/`
4. 用 `apply_patch` 同步修改 `matrix-manifest.json` 和 `index.html`，新增卡片的名称、描述与客户端资料保持一致，并将 mapping 表保存为矩阵内的可审计文件。
5. 每组发布前生成 contact sheet 并目检；尺寸不是 1024×1536 的新图可以仅作轻微尺寸归一化：`sips -z 1536 1024 <new-output>`。不要对旧近脸图做拉伸补救。
6. 结束时运行两个独立审计：
   - mapping 审计：27 个客户端 ID 恰好各映射一次；
   - 资产审计：27 × 7 = 189 个正式图均存在且为 1024×1536。
   然后用 `agent-browser` 切换全部 7 个脸型 tab 做页面截图核查。

## 已确认的发型语义

- **前置微分碎盖**：完整前置锅盖底子，中心仅窄 V 缝和 3–5 束轻碎刘海，根部蓬松；不能误生成为普通中分/三七分。
- **微碎盖**：短碎层、较短不规则刘海，和前置微分碎盖是不同款。
- **三七侧分**：自然 3:7 分线，一侧更长的弧形刘海扫过前额。
- **逗号刘海**：一侧有单独向内回勾的 C 形刘海；不是双侧帘幕。
- **自然卷短发**：短、松散自然卷、低蓬度。
- **蓬松纹理烫**：更明显的 S 纹理和根部蓬松，仍不可夸张。

## 客户端资料与边界

- 客户端完整样式库：`client/data/style-annotation/hairstyles-cn.json`。
- 当前工作区含有用户/其他任务未提交的 client 数据改动。不要重置、清理、覆盖或将其混入本矩阵任务。
- `server/benchmark-assets/` 是本地基准资产，受 `server/.gitignore` 忽略；因此该资产工作通常不会出现在 `git status`。

## 建议技能

- `$imagegen`：以 `models-v2` 本地图片作为编辑目标，采用 built-in image generation；每个目标先 `view_image`，不要切换 CLI。
- `$agent-browser`：刷新本地 `file://` 矩阵、切换脸型 tab、截图核查。
- `$implement`：若要将矩阵资产正式同步到客户端/服务端产品路径，先检查对应 OpenSpec 是否允许实施。

## 关键安全与质量规则

- 不要删除旧效果图；移动到 quality-review 归档目录。
- 不使用博主/网红原始肖像作为产品资产；仅提取发型结构描述，并处理许可问题。
- 不允许人脸漂移、侧脸、自作主张裁切、下巴缺失、头大身小、肤质重绘明显、文字或水印。
- Built-in imagegen 的原始输出在 `/Users/Ruihan/.codex/generated_images/`；选中的每张必须复制到项目路径后才能引用。
