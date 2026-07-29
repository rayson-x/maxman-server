# 穿搭合成刺激图修复：30 套近似图 → 精确匹配

> 交接日期：2026-07-29
> 任务来源：fit 审核台发现 30/59 套穿搭刺激图 matchQuality=close（语义近似），
> 审核与推荐展示需要精确匹配版。请按本清单逐套重新生成并覆盖原路径。

## 生成标准（与既有 29 套 exact 图保持一致）

- 虚构中国成年男性单人全身像，不含真实人物；不用于身份识别
- 统一浅色中性背景（参考现有 exact 图的影棚风格）、正面或微侧站姿、全身可见（头顶到鞋）
- 无品牌标识、无文字、无水印、无多余配饰
- **精确性验收**：公式描述中的每个槽位单品必须在图中出现，颜色、版型、长度与描述一致；
  多一件少一件都算失败（此前失败模式：宽松单西未出现、印花缺失、裤型错误）
- 分辨率与画幅对齐现有 exact 图（同 promptVersion 家族）

## 完成后动作

1. 覆盖 `client/public/style-lab/` 下对应 localPath 文件
2. 把 `client/data/style-annotation/synthetic-stimuli-outfits.json` 中该条目
   `matchQuality` 改为 `exact`，alt 文本去掉「语义近似」
3. 审核台角标会自动消失（页面直接读 matchQuality），无需改代码

## 修复清单（30 套）

### 1. outfit_cn_cleanfit_oxford_wide_slacks
- 目标：白牛津衬衫＋炭灰宽直西裤
- 描述：挺度适中的白色牛津衬衫不打领带，配炭灰中高腰宽直西裤、黑色细皮带和白色极简皮质运动鞋。
- 必须出现的槽位单品：
- top: 白色牛津衬衫
- bottom: 炭灰中高腰宽直西裤
- shoes: 白色极简皮质运动鞋
- accessory: 黑色细皮带
- 排除项：紧身九分西裤、厚底跑鞋、领带、透肤衬衫
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-00.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 2. outfit_cn_model_offduty_relaxed_blazer
- 目标：黑色背心T＋宽松单西＋垂坠黑裤
- 描述：黑色高领口背心T或贴身圆领T，外搭宽松黑色单西，配同色垂坠宽直裤和黑色方头短靴；依靠材质层次而非裸露。
- 必须出现的槽位单品：
- outer: 宽松黑色单西
- top: 黑色背心T或圆领T
- bottom: 黑色垂坠宽直裤
- shoes: 黑色方头短靴
- 排除项：深V裸露、紧身小脚裤、亮面礼服西装、厚底运动鞋
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-04.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 3. outfit_cn_model_offduty_bomber_dark_denim
- 目标：短款飞行夹克＋水洗T＋深色宽牛仔
- 描述：黑色或深棕短款飞行夹克内搭灰色水洗T，配深靛宽直牛仔和复古银灰跑鞋，形成上短下长的非正式男模感。
- 必须出现的槽位单品：
- outer: 黑色或深棕短款飞行夹克
- top: 灰色水洗T
- bottom: 深靛宽直牛仔
- shoes: 银灰复古跑鞋
- 排除项：超大长飞行夹克、紧身牛仔、多处破洞、竞速厚底鞋
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-05.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 4. outfit_cn_american_graphic_carpenter
- 目标：复古图案T＋棕色木工裤
- 描述：做旧黑灰单图案T配棕色宽直木工裤、帆布板鞋和素色棒球帽；锤环和贴袋保留但不挂载无用工具。
- 必须出现的槽位单品：
- top: 做旧黑灰单图案T
- bottom: 棕色宽直木工裤
- shoes: 黑白帆布板鞋
- accessory: 素色棒球帽
- 排除项：多个图案同时出现、仿制服徽章、裤脚拖地、无用战术挂载
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-01.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 5. outfit_cn_cityboy_coach_oxford_chino
- 目标：藏蓝教练夹克＋牛津衬衫＋卡其宽裤
- 描述：藏蓝教练夹克叠穿浅蓝牛津衬衫，配卡其中高腰宽直裤、灰白复古跑鞋和小号斜挎包。
- 必须出现的槽位单品：
- outer: 藏蓝教练夹克
- top: 浅蓝牛津衬衫
- bottom: 卡其中高腰宽直裤
- shoes: 灰白复古跑鞋
- accessory: 小号斜挎包
- 排除项：紧身卡其裤、商务皮鞋、大号战术包、多Logo
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-09.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 6. outfit_cn_cityboy_rugby_pleated_trousers
- 目标：条纹橄榄球衫＋深灰双褶宽裤
- 描述：米白藏蓝宽条橄榄球衫配深灰中高腰双褶宽裤、棕色麂皮鞋和素色帽；用一件条纹上衣建立焦点。
- 必须出现的槽位单品：
- top: 米白藏蓝宽条橄榄球衫
- bottom: 深灰双褶宽裤
- shoes: 棕色麂皮鞋
- accessory: 素色六片帽
- 排除项：上下同时条纹、紧身九分裤、亮面正装鞋、球队标识堆叠
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-11.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 7. outfit_cn_cleanboy_cardigan_beige_trousers
- 目标：浅灰开衫＋白T＋米色直筒裤
- 描述：浅灰细针织开衫叠穿白T，配米色中腰直筒裤和浅棕乐福鞋；适合换季约会和不要求西装的办公室。
- 必须出现的槽位单品：
- outer: 浅灰细针织开衫
- top: 白T
- bottom: 米色直筒裤
- shoes: 浅棕乐福鞋
- 排除项：粗大麻花纹、超长开衫、紧身裤、厚底运动鞋
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-06.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 8. outfit_cn_blokecore_jersey_denim
- 目标：中国队足球球衣＋深蓝直筒牛仔
- 描述：正版中国队或中超俱乐部短袖球迷版球衣，配深蓝直筒牛仔和薄底复古足球鞋；仅使用真实支持的球队，不混搭互斥队徽。
- 必须出现的槽位单品：
- top: 正版中国队或中超俱乐部球迷版球衣
- bottom: 深蓝直筒牛仔
- shoes: 薄底复古足球鞋
- 排除项：仿冒球衣、互斥球队标识混搭、球衣配完整比赛短裤、厚底老爹鞋
- 现有近似图（覆盖它）：`/style-lab/outfits-heritage-functional-v1/outfit-heritage-09.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-heritage-functional-contact-sheet-v1.png`

### 9. outfit_cn_blokecore_track_jacket_nylon
- 目标：足球训练夹克＋球衣＋黑尼龙裤
- 描述：黑色或球队色足球训练夹克敞开叠穿单一球衣，配黑色直筒尼龙裤和薄底运动鞋；保留赛前感但不穿护腿板等比赛装备。
- 必须出现的槽位单品：
- outer: 足球训练夹克
- top: 单一球队球衣
- bottom: 黑色直筒尼龙裤
- shoes: 薄底运动鞋
- 排除项：护腿板、钉鞋、多球队标识、完整比赛套装
- 现有近似图（覆盖它）：`/style-lab/outfits-heritage-functional-v1/outfit-heritage-10.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-heritage-functional-contact-sheet-v1.png`

### 10. outfit_cn_y2k_ziphoodie_baggy_cargo
- 目标：短款拉链帽衫＋叠穿长T＋宽工装裤
- 描述：短款深灰拉链帽衫内露白色长T下摆，配深灰宽松工装裤和银灰复古跑鞋；Y2K焦点放在上短下长和银色鞋。
- 必须出现的槽位单品：
- outer: 短款深灰拉链帽衫
- top: 白色长T
- bottom: 深灰宽松工装裤
- shoes: 银灰复古跑鞋
- 排除项：低腰露内裤、多条无用链饰、拖地裤脚、荧光全套
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-09.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 11. outfit_cn_y2k_denim_graphic_baggy
- 目标：宽松牛仔衬衫＋图案T＋水洗宽牛仔
- 描述：深水洗宽松牛仔衬衫敞开，内搭单图案T，配不同洗水的宽直牛仔和银白复古跑鞋；上下牛仔必须有深浅差。
- 必须出现的槽位单品：
- outer: 深水洗宽松牛仔衬衫
- top: 单图案T
- bottom: 浅水洗宽直牛仔
- shoes: 银白复古跑鞋
- 排除项：同洗水上下装、多图案叠加、重度破洞、裤脚拖地
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-01.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 12. outfit_cn_korean_boxyshirt_wide_slacks
- 目标：盒型短袖衬衫＋针织T＋宽西裤
- 描述：灰蓝盒型短袖衬衫敞开叠穿米白针织T，配深灰中高腰宽西裤和白色极简运动鞋，控制低对比和软垂感。
- 必须出现的槽位单品：
- outer: 灰蓝盒型短袖衬衫
- top: 米白针织T
- bottom: 深灰中高腰宽西裤
- shoes: 白色极简运动鞋
- 排除项：超长衬衫、紧身西裤、厚底老爹鞋、高对比印花
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-08.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 13. outfit_cn_korean_cropped_bomber_wide_denim
- 目标：短款灰夹克＋长白T＋宽直牛仔
- 描述：短款石灰色拉链夹克内搭白色长T，配深蓝宽直牛仔和灰白复古跑鞋；白T下摆只露少量，避免层次拖沓。
- 必须出现的槽位单品：
- outer: 短款石灰色拉链夹克
- top: 白色长T
- bottom: 深蓝宽直牛仔
- shoes: 灰白复古跑鞋
- 排除项：超短露腰、长T露出过多、拖地牛仔、竞速厚底鞋
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-02.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 14. outfit_cn_japanese_chore_pleated_chino
- 目标：靛蓝工装夹克＋米色双褶卡其裤
- 描述：靛蓝棉质工装夹克叠穿灰白圆领T，配米色中高腰双褶宽卡其裤和棕色麂皮鞋；贴袋保持扁平。
- 必须出现的槽位单品：
- outer: 靛蓝棉质工装夹克
- top: 灰白圆领T
- bottom: 米色双褶宽卡其裤
- shoes: 棕色麂皮鞋
- 排除项：做旧破损、口袋鼓胀、紧身卡其裤、重型工装靴
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-10.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 15. outfit_cn_japanese_cardigan_fatigue_pants
- 目标：棕色针织开衫＋军绿疲劳裤
- 描述：棕色中等粗细针织开衫叠穿米白T，配军绿直筒疲劳裤和深棕麂皮鞋；用棕、米、军绿形成受控大地色层次。
- 必须出现的槽位单品：
- outer: 棕色针织开衫
- top: 米白T
- bottom: 军绿直筒疲劳裤
- shoes: 深棕麂皮鞋
- 排除项：粗大图案针织、迷彩裤、紧身裤、厚重战术靴
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-06.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 16. outfit_cn_hiphop_oversizedtee_baggydenim
- 目标：宽幅图案T＋水洗垮感牛仔＋篮球鞋
- 描述：宽幅但肩线可辨的图案T搭深蓝水洗垮感牛仔、复古篮球鞋和棒球帽，以明显上下宽松和单个胸前图案构成大陆城市嘻哈日常版本。
- 必须出现的槽位单品：
- top: 宽幅图案T恤
- bottom: 深蓝水洗垮感牛仔
- shoes: 复古篮球鞋
- accessory: 素色棒球帽
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-01.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 17. outfit_cn_hiphop_jersey_cargo
- 目标：篮球背心叠白T＋宽工装裤
- 描述：宽松篮球背心叠穿长白T，搭黑色宽工装裤、篮球鞋和针织帽；与实战篮球条目区分，重点是球衣作为城市街头层次。
- 必须出现的槽位单品：
- top: 宽松篮球背心叠白T
- bottom: 黑色宽工装裤
- shoes: 篮球鞋
- accessory: 针织帽
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-03.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 18. outfit_cn_skate_hoodie_baggydenim
- 目标：重磅帽衫＋褪色宽牛仔＋滑板鞋
- 描述：深灰重磅帽衫搭浅灰褪色宽牛仔、黑白低帮滑板鞋和针织帽；比格纹木工版本更简洁，观察重点是裤型、鞋底和活动量。
- 必须出现的槽位单品：
- top: 深灰重磅帽衫
- bottom: 浅灰褪色宽牛仔
- shoes: 黑白低帮滑板鞋
- accessory: 针织帽
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-02.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 19. outfit_cn_highstreet_longcoat_turtleneck
- 目标：黑色长大衣＋高领针织＋宽西裤
- 描述：过膝前后的黑色长大衣搭贴颈高领针织、炭灰宽西裤和方头短靴，以拉长比例、低色彩和明显廓形构成可落地高街版本。
- 必须出现的槽位单品：
- outer: 黑色长大衣
- top: 炭黑高领针织
- bottom: 炭灰宽西裤
- shoes: 黑色方头短靴
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-14.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 20. outfit_cn_yabi_fadedhoodie_flaredcargo
- 目标：做旧拉链帽衫＋长图案T＋微喇工装裤
- 描述：褪黑短拉链帽衫叠长图案T，搭深灰微喇工装裤、金属链和厚底运动鞋；以做旧、长短层次和少量金属作为可观察亚比候选，不把标签写成固定定论。
- 必须出现的槽位单品：
- outer: 褪黑短拉链帽衫
- top: 长款小图案T
- bottom: 深灰微喇工装裤
- shoes: 灰黑厚底运动鞋
- accessory: 一条金属裤链
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-11.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 21. outfit_cn_techwear_vest_articulatedcargo
- 目标：轻壳叠功能马甲＋立体裁片机能裤
- 描述：黑灰轻壳外套叠多袋但不鼓胀的功能马甲，搭立体裁片锥形机能裤和灰黑越野鞋；以面料、口袋和裁片作为机能依据。
- 必须出现的槽位单品：
- outer: 黑灰轻壳外套叠功能马甲
- bottom: 立体裁片锥形机能裤
- shoes: 灰黑越野鞋
- accessory: 小型斜挎包
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-heritage-functional-v1/outfit-heritage-14.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-heritage-functional-contact-sheet-v1.png`

### 22. outfit_cn_darkavant_asymmetric_layers
- 目标：短夹克＋不对称长衫＋垂裆黑裤
- 描述：短款黑夹克叠不对称长衫，搭低垂裆但裤脚收束的黑裤和窄楦黑靴，以单色、长短差和非传统裤型构成暗黑先锋候选。
- 必须出现的槽位单品：
- outer: 短款黑夹克
- top: 不对称下摆黑色长衫
- bottom: 垂裆收脚黑裤
- shoes: 窄楦黑靴
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-15.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 23. outfit_cn_punk_rider_plaidtrousers
- 目标：骑士皮夹克＋乐队T＋红黑格纹裤
- 描述：黑色短骑士皮夹克搭褪黑乐队T、红黑窄格直筒裤和系带皮靴，以皮革、格纹和音乐图案构成朋克摇滚版本。
- 必须出现的槽位单品：
- outer: 黑色短骑士皮夹克
- top: 褪黑乐队T
- bottom: 红黑窄格直筒裤
- shoes: 黑色系带皮靴
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-street-subculture-v1/outfit-street-13.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-street-subculture-contact-sheet-v1.png`

### 24. outfit_cn_amekaji_deck_chambray_chino
- 目标：海军甲板夹克＋青年布衬衫＋卡其裤
- 描述：深海军蓝甲板夹克叠浅蓝青年布衬衫，搭米褐直筒卡其裤和棕色工装靴，用耐用面料、军用来源和旧式美式比例构成阿美咔叽条目。
- 必须出现的槽位单品：
- outer: 深海军蓝甲板夹克
- top: 浅蓝青年布衬衫
- bottom: 米褐直筒卡其裤
- shoes: 棕色工装靴
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-heritage-functional-v1/outfit-heritage-00.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-heritage-functional-contact-sheet-v1.png`

### 25. outfit_cn_running_windshell_twainone
- 目标：轻量跑步风壳＋背心＋二合一短裤
- 描述：高可视但不荧光过量的轻量跑步风壳，内搭速干背心，配黑色二合一跑步短裤、路跑鞋和运动表，服务城市晨跑和风雨天气。
- 必须出现的槽位单品：
- outer: 轻量跑步风壳
- top: 速干跑步背心
- bottom: 黑色二合一跑步短裤
- shoes: 公路跑鞋
- accessory: 运动表
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-heritage-functional-v1/outfit-heritage-12.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-heritage-functional-contact-sheet-v1.png`

### 26. outfit_cn_running_coldlayer_tights
- 目标：长袖跑步上衣＋轻马甲＋紧身跑裤
- 描述：深蓝长袖速干上衣叠轻量保暖跑步马甲，搭黑色全长跑步紧身裤、路跑鞋和薄手套，作为大陆秋冬晨跑的功能分层。
- 必须出现的槽位单品：
- outer: 轻量保暖跑步马甲
- top: 深蓝长袖速干上衣
- bottom: 黑色全长跑步紧身裤
- shoes: 公路跑鞋
- accessory: 薄手套
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-heritage-functional-v1/outfit-heritage-12.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-heritage-functional-contact-sheet-v1.png`

### 27. outfit_cn_tennis_polo_seveninchshorts
- 目标：白色网球Polo＋七英寸短裤＋球场鞋
- 描述：白色或米白速干网球Polo搭藏蓝七英寸左右短裤、白色球场鞋和护腕，以翻领、活动量和场地鞋形成实战网球条目。
- 必须出现的槽位单品：
- top: 白色速干网球Polo
- bottom: 藏蓝七英寸运动短裤
- shoes: 白色网球场地鞋
- accessory: 白色护腕
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-v1/outfit-07.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-contact-sheet-v1.png`

### 28. outfit_cn_golf_polo_pleatedtechnicaltrousers
- 目标：针织感高尔夫Polo＋单褶功能长裤
- 描述：深海军蓝针织感功能Polo搭浅灰单褶弹力长裤、白棕高尔夫鞋和简洁球帽，在球场着装规范内保留中国城市男性可复现的整洁比例。
- 必须出现的槽位单品：
- top: 深海军蓝功能Polo
- bottom: 浅灰单褶弹力长裤
- shoes: 白棕高尔夫鞋
- accessory: 无大Logo球帽
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-v1/outfit-07.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-contact-sheet-v1.png`

### 29. outfit_cn_hongkong_floral_pleatedtrousers
- 目标：深色花短袖衬衫＋高腰褶裤＋乐福鞋
- 描述：深色小尺度花纹短袖衬衫半敞穿白背心，搭炭灰高腰双褶直筒裤和黑色乐福鞋，以90年代媒体常见比例形成港风候选。
- 必须出现的槽位单品：
- top: 深色小尺度花纹短袖衬衫叠白背心
- bottom: 炭灰高腰双褶直筒裤
- shoes: 黑色乐福鞋
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-modern-clean-v1/outfit-clean-16.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-modern-clean-contact-sheet-v1.png`

### 30. outfit_cn_hongkong_denim_tank_chelsea
- 目标：短牛仔夹克＋白背心＋深色直筒牛仔
- 描述：中蓝短牛仔夹克内搭白色罗纹背心，配深靛直筒牛仔和黑色切尔西靴，用短上衣、双丹宁深浅和简洁皮靴构成港风牛仔候选。
- 必须出现的槽位单品：
- outer: 中蓝短牛仔夹克
- top: 白色罗纹背心
- bottom: 深靛直筒牛仔
- shoes: 黑色切尔西靴
- 排除项：无
- 现有近似图（覆盖它）：`/style-lab/outfits-v1/outfit-14.png`
- 所属 contact sheet：`/style-lab/chinese-outfit-contact-sheet-v1.png`
