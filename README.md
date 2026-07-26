# BetterMeet Server

AI 男性形象改善产品的服务端。目标用户是 18-26 岁中国男性（学生到初入职场）。
（BetterMeet 是内部代号，产品最终名称待定。）

本仓库独立管理。跨端的产品与架构设计在上级 workspace 的 `docs/`，不在这里维护。

## 快速开始

```bash
npm install
cp .env.example .env          # 填入各供应商密钥
docker compose up -d          # 或自备 Postgres 5433 + Redis 6379
npx prisma migrate deploy
npx prisma generate           # 生成物在 src/generated/，不入库

npm run dev                   # API，:8787
npm run dev:worker            # worker，另开一个终端
```

Worker 必须单独起。API 进程只负责入队，实际执行在 worker 里——
`POST /analysis-jobs` 会返回 202 然后 job 停在 `created`，如果 worker 没跑。

## 验证

```bash
npx tsc --noEmit
npm run test:weather                # 天气适配器、历史 JSON、prompt 隔离
bash scripts/smoke-http-flow.sh    # HTTP 全链路，⚠ 产生真实图片费用（约 ¥0.6）
npx tsx src/scripts/seed-test-style-data.ts   # 冒烟测试前需要：写入测试用风格数据
```

`src/scripts/` 下约 35 个验证脚本，各自可独立运行。命名即用途，
例如 `test-redis-semaphore.ts`（并发信号量边界）、`test-materialize-idempotent.ts`（S5 幂等）。

⚠ **`scripts/smoke-http-flow.sh` 与 `src/scripts/test-e2e-flow.ts` 的分工是刻意的**：
后者直接调 step 函数，因此测不出编排层缺失——它曾经全绿而 HTTP 链路是断的。
涉及"零件是否装成整机"的验证必须走前者。

## 天气数据

首版天气入口只接受客户端明确提供的 `province` + `city`，两者必须同时存在。
Agent 每次运行前会：

1. 解析省市到城市、坐标和 IANA 时区；
2. 读取或刷新最近滚动 36 个月的日最低/平均/最高温；
3. 把历史数据写入 `data/weather-history/<sha256>.json`；
4. 获取当前、体感温度和未来 7/10/15 日最低/最高温；
5. 只将 12 个月度摘要与实时/预报业务字段作为本次请求的 system context。

运行时 JSON、原始供应商响应和约 1,096 条历史日数据都不会进入 prompt，也不入库。
缓存采用校验后读取和临时文件原子替换，损坏、过期或范围不完整时会自动重拉。

开发/评估默认使用 Open-Meteo 公共 Geocoding、Historical Weather 和 Forecast
端点。生产流量必须在 `.env` 中换成许可合适的 commercial/customer 或自托管 HTTPS
端点；可同时设置 `WEATHER_API_KEY`。其他边界配置见 `.env.example`。当前没有做
IP/GPS 定位、天气数据库或自研气温预测模型。对外展示天气数据时还必须按
Open-Meteo 的 CC BY 4.0 数据许可提供适当署名。

## 架构要点

按 `openspec/changes/add-mvp1-backend-flow/design.md` 的 16 条决策实现，
每条标注了 `实测` / `逻辑推演` / `产品决策` 三种依据强度。几条最容易踩的：

- **图片生成并发上限为 1，粒度是 `req_key` 而非账号。** BullMQ 的 `concurrency`
  是每 Worker 实例上限、`limiter` 是启动速率限制，**两者都给不了全局并发保证**。
  真正的闸门是 `lib/redisSemaphore.ts` 的 Redis 信号量，持槽覆盖整个 submit→poll
  生命周期。详见 design.md 决策 12。
- **脸型由客户端 MediaPipe 测量，服务端不重新判断。** 云端视觉判断脸型实测
  两家一致率仅 2/10。云端只做语义分析（当前发型、发际线是否被遮挡等）。
- **协调性与排序由数据驱动的确定性公式给出，不交给 LLM 判断审美。**
  被确定性过滤掉的候选，LLM 完全接触不到。
- **部分成功是一等公民。** 渐进式推送下"全或无"自相矛盾——已推给用户的图收不回。
- **供应商异步调用提交后立刻落盘 callId**，断线后凭 callId 恢复轮询而非重新提交
  （重复提交 = 重复计费）。

## 目录

```
src/
├── app/          容器（唯一组装根）、jobOrchestrator（jobType → step 管道）
├── routes/       HTTP 端点
├── steps/        S1-S5，每个可独立调用、可独立重试
├── services/     跨 step 的业务逻辑
├── repositories/ 数据访问 + 状态机
├── features/appearance-agent/
│   ├── providers/  各供应商适配（vision/imageEdit/clothing/textToImage/…）
│   ├── data/       词库、风格向量、领域词表、打分维度映射
│   └── rules/      发型硬约束决策矩阵
├── lib/          队列、信号量、OSS、taskLedger、AI 内容标识
└── scripts/      验证脚本
openspec/         规格与变更提案（spec-driven，用 openspec 命令查看）
test-fixtures/    长期保留的测试素材（10 张中国男性测试脸等）
```

## 已知未完成

- **风格数据是测试占位的**（`seed-test-style-data.ts`，id 前缀 `test-`、
  `source=test_fixture_not_research`）。真实数据待调研交付，当前推荐结果不具备产品意义。
- `taskDimensions.ts` 的档位数值是初始校准，影响 core/optional 切分，待真实完成率数据校准。
- 内容安全供应商未接（本地 MVP 阶段搁置），S1 只跑确定性红线规则并如实标记缺口。
