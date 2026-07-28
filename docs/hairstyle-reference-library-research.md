# 真实人脸 × 发型参考库调研

> 调研日期：2026-07-28。只采用数据集维护方、论文作者项目页、素材平台或品牌的官方页面。这里的“可生产”指能作为 BetterMeet 面向用户展示的静态发型卡，或用于商业训练/微调；不替代法务对单个合同、地区与个人肖像权的审核。

## 结论先行

目前没有找到一个同时满足“真人正脸可见、发型标签细、可直接商用展示、可用作训练数据”四项的开放发型库。最接近研究需求的是 **K-Hairstyle**，但它将脸部模糊处理，官方项目页没有公布商业授权条款；它适合研究发型结构与分割，不适合作为产品里的真人脸型 × 发型示例。CelebA、CelebAMask-HQ 和 FFHQ 也都不能直接作为商业产品素材或商业训练的通用解法。

因此，建议把“训练/校准参考”和“用户可见样片”彻底分开：前者可在许可允许范围内用于离线研究；后者应由自有拍摄（最优）或逐张取得适配产品用途的商业授权获得。不要把品牌 lookbook、理发师视频截帧、明星/博主照片或研究集图片直接放进可选择的发型卡。

对“微分碎盖”，当前问题并不主要是缺少一个更强的文生图模型，而是产品术语将两个不同的剪裁结构混在同一张卡里：`微分盖`（完整、连续、浅分线的盖感）与 `微碎盖`（更短、明显碎层、断续刘海的 crop）需要各自独立建模、采样和验收。项目现有关键词库已经把两者拆开；客户端的“微分碎盖”条目仍将两种要素合并，见下文。

## 可考察的数据集

| 数据集 | 真人/标签能力 | 授权与生产结论 | 推荐用途 |
| --- | --- | --- | --- |
| K-Hairstyle | 50 万张、最高 4032×3024、31 个基础发型+63 个属性；有长度、卷度、刘海、侧区、颜色、前后造型状态和人工头发 mask；同人多视角 | 项目页明确称为公开下载，但页面未列出许可或商用条款；且人脸已模糊。**不可直接作为产品真人示例；不可在未取得作者/权利方书面商业许可前用于训练。** | 离线研究“结构字段应如何拆分”、分割和多视角验收的参考。 |
| Hairstyle30K | 论文作者公开描述为 3 万张网页搜索采集的真人图，64 类发型；适合说明已有“真实发型分类集” | 论文说明图像来自网络搜索，未提供逐图可商用权利链或可验证的商业数据许可。**不可直接用于生产展示或商业训练。** | 仅作学术分类法参考，不能当素材库。 |
| CelebA / CelebAMask-HQ | CelebA 有 202,599 张名人脸、5 landmarks、40 个二元属性；CelebAMask-HQ 有 3 万张和包含 `hair` 在内的 19 类分割 mask | CelebA 和 CelebAMask-HQ 都明确限定“non-commercial research”；且禁止对图像及 derived data 商业利用。**不可生产。** | 若团队独立做非商业原型，可验证人像/头发分割；不要进入产品训练或素材链。 |
| FFHQ | 7 万张 1024px 真人脸、带原 Flickr 来源、作者、许可与 68 landmarks metadata；没有细粒度发型标签 | 数据集整体 CC BY-NC-SA 4.0，逐图来源中也包含 BY-NC；NVIDIA 说明均只作非商业使用。**不可作为商业训练或展示的默认来源。** | 研究阶段的人像构图、脸部保真度评测参考；若未来逐张取得独立权利，必须重新做权利审计。 |

### 关键一手证据

- [K-Hairstyle 作者项目页](https://psh01087.github.io/K-Hairstyle/)：说明 50 万高分辨率样本、人工专家标注、31 类+63 属性、正侧多视角、头发/模糊脸 mask；字段包括 `Basestyle`、`Length`、`Curl`、`Bang`、`Side` 和 `Before-after`。访问于 2026-07-28。项目页同时明确“Due to the privacy issue, we made the facial region blurry”；其下载段落未给出 license 或商业条款，因此不能把“可下载”推定为可商用。
- [K-Hairstyle 作者论文（ICIP 2021）](https://arxiv.org/abs/2102.06288)：确认全量、分割、多视角和“faces are blurred”的设计。访问于 2026-07-28。
- [Hairstyle30K 作者论文](https://yanweifu.github.io/papers/hairstyle_v_14_weidong.pdf)：作者称其为 30K 张、64 类，且图像由搜索引擎按发型本体关键词采集。访问于 2026-07-28。网页采集来源本身不能形成素材转授权。
- [CelebA 官方页](https://mmlab.ie.cuhk.edu.hk/projects/CelebA.html)：列出规模和标注，并明确仅限非商业研究、不得商业利用图像及 derived data。访问于 2026-07-28。
- [CelebAMask-HQ 官方仓库](https://github.com/switchablenorms/CelebAMask-HQ)：列出 19 类（含 hair）的人工 mask，并明确限非商业研究。访问于 2026-07-28。
- [NVIDIA FFHQ 官方仓库](https://github.com/NVlabs/ffhq-dataset)：列出 70K、来源/许可 metadata，且数据集整体为 CC BY-NC-SA 4.0，逐图来源包含非商业许可。访问于 2026-07-28。

## 真实模特 / 专业品牌素材是否能直接用

### 商业图库：可做“展示采购”，但不能做训练集，也不是一键无限复用

[Adobe Stock 官方许可说明](https://helpx.adobe.com/stock/help/usage-licensing.html) 说明：非 editorial 素材可用于网站等创意项目；含可识别人物的商业素材有签署的 model release，editorial 素材没有该 release，不能商用；许可不转移所有权且不独家（访问于 2026-07-28）。

这使其成为“从搜索到的候选中，逐张买下 1–2 张真实模特发型卡”的可行备选，但前提是：

1. 只选明确标为 commercial / non-editorial 的素材，保存 asset ID、许可版本、购买账户和下载记录；
2. 逐张核对该许可能否覆盖 App 内的长期展示、修改和预计分发量；不得把“有 model release”误解为可以训练模型或获得独占人物形象；
3. 不能用同一张图暗示该模特做过用户实际将获得的发型或为 BetterMeet 背书；避免品牌、发廊和产品商标入镜；
4. 采购的静态卡与模型训练数据隔离。Adobe FAQ 本身不构成训练权利授予，训练须另取得相应的书面数据权利。

[Shutterstock 官方许可条款](https://www.shutterstock.com/license) 对本产品形态更不友好：条款禁止把内容作为“供第三方搜索和选择的 gallery”的一部分展示，也禁止用视觉内容作为 AI/ML/生成式 AI 的训练数据（访问于 2026-07-28）。**所以不要把 Shutterstock 的普通素材许可当作发型选择器卡片或训练数据的许可；如要使用，只能先取得覆盖该交互形态的单独书面授权。**

### 专业美发品牌 lookbook：适合“观察结构”，不适合直接搬运

[L’Oréal Professionnel 网站条款](https://www.lorealprofessionnel.com/legal/website-terms-of-use) 将网站图片、视频等列为受知识产权保护内容，普通可下载内容仅授权个人、私用，复制/修改/分发需要事先明确授权（访问于 2026-07-28）。[Schwarzkopf Professional 条款](https://www.schwarzkopf-professional.com/ca/en/terms-of-use.html) 也要求使用网站图像材料事先书面同意，新闻图仅可 editorial 使用（访问于 2026-07-28）。

故品牌官方 lookbook、教育视频、发型师社媒和乐仔 Levi 等视频可作为人工审美/剪裁术语的**不可入库参考**，不能截图、抓取后放入产品，也不应作为供应给生成模型的未授权图像资料。若希望展示真实发型，优先找品牌或发廊进行明确合作并取得可展示、可裁切、可用于推荐卡的授权；仅“网上能看见”不等于获得了这些权利。

## “微分碎盖”为什么更容易跑偏

### 术语没有一个统一的国际剪裁标准

“微分碎盖”是中文市场的混合营销名，而不是可由单一英文发型名无歧义检索到的标准。现有专业男士教育也把结果拆成可调的形状、纹理和方向：例如 [American Crew 的专业教育课程说明](https://education.americancrew.com/main/classdescriptions) 把表面纹理、头发运动和整体形状完整性作为独立技能（访问于 2026-07-28）。因此，生成模型只收到“micro-part textured fringe”时，极容易退化为任意的中分、法式短碎或韩式两段式。

项目内部已经显式区分了两条结构：

| 应拆成的卡片 | 项目现有结构定义 | 应在图像验收中看到 | 必须排除 |
| --- | --- | --- | --- |
| 微分盖（`Subtle-part fringe cover`） | 顶部 7–9cm、自然浅 6:4、连续柔顺的盖感刘海、两侧低锥形；不做碎层或断续短刘海 | 前额有小而非硬的偏分开口；两束仍连续覆盖额头；整体是“盖”，不是露额中分 | 根部清晰中分、两片 curtain、短而锯齿的前缘、明显 fade |
| 微碎盖（`Micro textured fringe crop`） | 顶部 5–7cm、明显碎层，眉前短且不齐、断续的碎刘海、两侧低渐变；不留完整盖感或清晰分线 | 更短的破碎前缘、可数的离散发束、两侧低渐变、前额只少量露出 | 连续盖刘海、中央/偏中央完整分缝、长幕帘、光滑贴头皮 |

上表的结构来自项目已有的 [发型结构关键词词库](./hairstyle-keyword-taxonomy.md)；而 [客户端“微分碎盖”条目](../../client/data/style-annotation/hairstyles-cn.json) 同时写了“向前覆盖 + 中央/近中央窄开口 + airy textured”，长度又是 60–100mm。它更接近第一行的“微分盖”，却用了第二行容易触发的“碎盖”名称。**这是当前生成卡与用户期待不一致的直接产品定义风险。**

建议立即把展示库拆为两个 `styleId`，并为每张真人/生成样片附上以下机器可检验字段，而不是只存自然语言名称：

```text
topLengthMmRange, fringeLengthMmRange, partPosition, partWidth,
fringeContinuity, fringeDirection, layerSeparation, foreheadCoverage,
sideTreatment, crownVolume, finishTexture, referenceRightsId
```

图像评审也应要求正面 + 45° + 侧面三张，而不能只在正脸上判断。K-Hairstyle 的多视角、头发 mask 与“剪前/剪后”字段正好证明这是合理的数据模型，但它不是可复用的人像素材来源。

## 可执行的素材与校准路线

1. **两周内先修定义，不继续扩散生成。** 把现有“微分碎盖”拆为“微分盖”和“微碎盖”；每个定义输出上述字段、3 个正例、3 个反例和一段禁止项。先让发型师审核结构，再调用 Seedream/ImageGen；缺少通过审核的样片不得发布。
2. **建立自有“基准模特库”。** 签约 7 个脸型、每人 3 视角、统一灯光/服装/头肩构图；逐人取得 App 展示、裁切、衍生编辑、模型训练（如未来需要）分别勾选的授权。每个发型由发型师完成后实拍，原片、发型字段、授权版本、拍摄日期进入 `referenceRightsId` 管理。这是唯一能同时解决真实感、脸型匹配和权利链的路线。
3. **过渡期可用“商业图库展示卡”，不用它校准模型。** 逐张选 Adobe Stock 的 non-editorial、已 model-released 内容；先由法务确认具体条款与用量。避免 Shutterstock 普通许可，因为其官方条款明确限制 selection gallery。所有买图放在“展示资产”仓，禁止复制到训练/提示词参考仓。
4. **研究资产与生产资产物理隔离。** K-Hairstyle/CelebA/CelebAMask-HQ/FFHQ 只允许进入研究环境和评测文档；不得导出为 CDN 卡片、训练素材或客户可见图片。每项资产记录 `sourceUrl`、`license`、`accessedAt`、`allowedPurpose`、`rightsOwner`。
5. **把模型的成功定义从“看起来像发型”改为可检验。** 每个目标卡至少测：脸部身份相似度、下巴/耳朵/颈肩不变、发际线不漂移、关键结构字段命中率、三视角一致性。任一项失败即回退，不以“头发质感更好”抵消脸形变或剪裁错误。

