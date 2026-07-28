# 发型结构关键词词库（Seedream 校准用）

> 这是模型校准和候选库扩充的研究素材，不等于已向用户发布的可选发型。新增用户可选项前，仍须走对应 OpenSpec 变更与推荐规则评审。

## 写法

不要把 `fade`、`side part` 这类复合营销名直接作为生成指令。每条图像编辑描述至少应覆盖以下维度，再只把结构描述传给模型（中文名只作 UI 标签）：

| 维度 | 取值示例 |
| --- | --- |
| 顶部长度 | 6–10mm、1cm、3–4cm、5–7cm、8–10cm、10cm+ |
| 分线 | 无、中分、左/右侧分、3:7、窄硬分线 |
| 刘海 | 无、超短、齐、碎、斜、幕帘、逗号 |
| 纹理 | 顺直、碎层次、蓬松、波浪、小卷、紧卷 |
| 两侧/后颈 | 均匀推短、自然锥形、低/中/高渐变、贴皮、drop/burst fade、断层、留长 |

## 41 款结构化候选词

| 中文 | English | 图像编辑结构描述 |
| --- | --- | --- |
| 短寸 | Buzz cut | 全头均匀推至约 6–10mm，无刘海，额头完全露出 |
| 平头 | Flat top | 顶部短发向上竖起并修成平面，侧后自然锥形 |
| 圆寸 | Butch cut | 全头均匀短寸约 1–1.5cm，轮廓圆润，无分线 |
| 板寸渐变 | Buzz with skin fade | 顶部 1cm 均匀短寸，两侧从贴皮向上平滑渐变 |
| 高紧短发 | High and tight | 顶部 2–3cm 短而平整，两侧高位贴皮渐变 |
| 常规短发 | Short back and sides | 顶部 3–4cm 自然梳理，两侧后颈短而自然锥形 |
| 常春藤 | Ivy League | 顶部 4–5cm，轻微侧分向一侧梳，两侧自然锥形 |
| 军事短发 | Crew cut | 顶部由前略长向后变短，前部微微上扬，两侧短锥形 |
| 法式短碎 | French crop | 顶部 4–5cm 碎层次，短碎刘海横向落在额前，两侧低渐变 |
| 凯撒头 | Caesar cut | 顶部短而均匀向前梳，短而平直的齐刘海，两侧短锥形 |
| 微分盖 | Subtle-part fringe cover | 顶部 7–9cm，顶部有自然浅 6:4 分线但不露硬分缝，连续柔顺的盖感刘海轻盖额头，两侧低锥形；不做碎层或断续短刘海 |
| 微碎盖 | Micro textured fringe crop | 顶部 5–7cm 打碎成明显碎层次，眉前短而不齐、断续的碎刘海，两侧低渐变；不保留完整盖感或清晰分线 |
| 纹理碎盖 | Textured crop | 顶部 5–7cm 明显碎层次，前部不规则碎刘海，两侧中低渐变 |
| 齐刘海短发 | Blunt fringe crop | 顶部 5–6cm，刘海平直齐剪至眉上，两侧中渐变 |
| 斜刘海短发 | Side-swept fringe | 顶部 6–7cm，刘海斜向一侧覆盖额角，两侧低锥形 |
| 逗号刘海 | Comma hair | 中短顶部蓬松，前刘海在一侧向内弯成逗号，保留部分额头 |
| 幕帘中分 | Curtain fringe | 顶部 8–10cm，自然中分，两束刘海向两侧垂至眉眼附近 |
| 中分层次短发 | Center-part layered cut | 顶部 8–10cm 正中分开，两侧分层垂落，耳朵半露 |
| 软侧分 | Soft side part | 顶部 6–8cm，自然侧分，无硬刻线，刘海轻扫额角 |
| 三七侧分 | 7:3 side part | 顶部 6–8cm，固定 3:7 分线，较少一侧贴顺，额头露出 |
| 硬分侧背 | Hard-part comb over | 顶部 6–8cm，清晰窄分缝，头发向一侧后方梳，两侧中渐变 |
| 经典油头 | Classic pompadour | 顶部 8–10cm 向后上方梳起，前额有圆润高度，两侧自然锥形 |
| 现代蓬巴杜 | Pompadour with fade | 顶部 8–10cm 向后上方蓬松，两侧高位渐变，额头完全露出 |
| 大背头 | Slick back | 顶部 8–10cm 全部向后贴顺梳理，额头露出，两侧低渐变 |
| 蓬松后梳 | Textured slick back | 顶部 8–10cm 向后梳但保留蓬松碎纹理，两侧自然锥形 |
| 飞机头 | Quiff | 顶部 7–9cm 向前上方抓起，前额形成明显高度，两侧中渐变 |
| 纹理前刺 | Textured spiky crop | 顶部 4–6cm 发束向上前方短刺，额头露出，两侧中渐变 |
| 人字前刺 | Faux hawk | 顶部中央向上形成窄脊，前部上翘，两侧向中间收短 |
| 断层短发 | Disconnected undercut | 顶部 8–10cm 保持长且蓬松，顶部与两侧有清晰长度分界，两侧后颈很短 |
| 低渐变纹理短发 | Low fade textured top | 顶部 5–7cm 碎层次，两侧仅耳周与后颈低位渐变 |
| 中渐变纹理短发 | Mid fade textured top | 顶部 5–7cm 碎层次，两侧从太阳穴中位渐变 |
| 高渐变短碎 | High fade crop | 顶部 4–5cm 短碎层次，两侧高位渐变，轮廓强对比 |
| 落差渐变碎盖 | Drop fade crop | 顶部碎盖，渐变线在耳后向下弯落，后颈更低 |
| 爆炸渐变卷发 | Burst fade curls | 耳周半圆形渐变，顶部保留蓬松卷发，后颈保留长度 |
| 自然卷短发 | Curly crop | 顶部 5–7cm 自然小卷，前部散落卷刘海，两侧低渐变 |
| 纹理烫短发 | Textured perm | 顶部 6–8cm 明显 S 形或小卷纹理，发根蓬松，两侧短锥形 |
| 韩式蓬松两段式 | Soft two-block | 顶部与前区 8–10cm 蓬松分层，两侧仅剪短、不贴皮、不强渐变 |
| 波浪侧分 | Wavy side part | 顶部 7–9cm 自然波浪，柔和侧分，侧后自然锥形 |
| 自然卷渐变 | Curly taper fade | 顶部保留紧密自然卷，两鬓和后颈低位渐变，整体圆润 |
| 现代狼尾 | Modern mullet | 顶部 6–8cm 有纹理，两侧耳上修短，后颈保留明显较长层次 |
| 长层次后梳 | Long layered flow | 顶部和两侧 10cm 以上，中分或后梳，耳朵半遮，保留自然流向 |

## 首批能力压力包

固定同一张真实正脸、同一模型、2K、同一 seed，测试生产模板与 Seedream 专用模板：短寸、法式短碎、三七侧分、幕帘中分、硬分侧背、断层短发、自然卷渐变、现代狼尾。

其中短寸、三七侧分为现有候选库精确项；法式短碎、幕帘中分、自然卷渐变仅为近似项；硬分侧背、断层短发、现代狼尾是能力探测，**不可因测通就宣称为已发布选项**。

## 资料来源

- [Wahl Professional 剪裁指南](https://www.wahlpro.com/amfile/file/download/file/762/product/1818/)
- [Andis Barber & Stylist Education](https://www.andis.com/BarberStylistEducation/Videos/)
- [Andis Side Part Fade 教学](https://andis.com/BarberStylistEducation/VideoDetail?EduItemID=1446)
- [Schorem 理发学院课程](https://schorembarbier.nl/the-5-day-all-around-the-schorem-way-at-the-old-school/)
