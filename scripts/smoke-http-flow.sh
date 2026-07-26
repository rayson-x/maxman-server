#!/usr/bin/env bash
# 本地 onboarding 全链路 HTTP 冒烟测试。
#
# 与 src/scripts/test-e2e-flow.ts 的区别很关键：那个直接调 step 函数与 service，
# 因此**测不出编排层缺失**——它曾经全绿，而 HTTP 链路其实是断的。
# 这个脚本只用 curl 打真实端点，走 HTTP → 队列 → worker → 编排器 → step 全程。
#
# 前置：服务与 worker 已启动，且已跑过 seed-test-style-data.ts（否则 S3 无候选）。
# ⚠ 会产生真实图片生成费用（每张约 ¥0.2）。
set -uo pipefail

B=${BASE_URL:-http://localhost:8787}
J=$(mktemp)
trap 'rm -f "$J"' EXIT
pass=0; fail=0

ok()   { pass=$((pass+1)); printf "✅ %s\n" "$1"; }
bad()  { fail=$((fail+1)); printf "❌ %s\n   %s\n" "$1" "${2:-}"; }
jqf()  { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a?.[k],o);console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('')}})" "$1"; }

printf "\n=== 1. 会话与采集 ===\n"
curl -s -c "$J" -X POST "$B/auth/device-session" -o /dev/null
SID=$(curl -s -b "$J" -c "$J" -X POST "$B/auth/device-session" | jqf deviceSessionId)
[ -n "$SID" ] && ok "签发 device session" || bad "签发 device session"

R=$(curl -s -b "$J" -c "$J" -X POST "$B/questionnaire/basic" -H 'content-type: application/json' \
  -d '{"track":"short_term","ageConfirmed18Plus":true,"birthDate":"2002-05-01","eventType":"第一次约会","eventDate":"2026-08-20"}')
[ "$(echo "$R" | jqf ok)" = "true" ] && ok "basic 问卷" || bad "basic 问卷" "$R"

R=$(curl -s -b "$J" -X POST "$B/questionnaire/full" -H 'content-type: application/json' \
  -d '{"heightCm":175,"weightKg":68,"exercisesRegularly":true,"occupation":"学生","wearsGlasses":true,"hasBeard":false,"selfReportedHairVolume":"medium","hairLossConcern":false,"domainSelections":["hairstyle","outfit","face_grooming","skincare","posture"],"budgetTier":"medium","changeWillingness":"distressed"}')
[ "$(echo "$R" | jqf ok)" = "true" ] && ok "full 问卷（矛盾校验 $(echo "$R" | jqf contradictions)）" || bad "full 问卷" "$R"

for c in terms face_processing; do
  R=$(curl -s -b "$J" -X POST "$B/photos/consent" -H 'content-type: application/json' -d "{\"consentType\":\"$c\",\"version\":\"v1\"}")
  [ -n "$(echo "$R" | jqf consentId)" ] && ok "同意存证 $c" || bad "同意存证 $c" "$R"
done

printf "\n=== 2. 照片直传 ===\n"
upload() { # $1=photoType  $2=本地文件 → 回显 storageKey
  local resp key url
  resp=$(curl -s -b "$J" -X POST "$B/photos/upload-url" -H 'content-type: application/json' -d "{\"photoType\":\"$1\",\"contentType\":\"image/jpeg\"}")
  key=$(echo "$resp" | jqf storageKey); url=$(echo "$resp" | jqf url)
  case "$url" in https://*) ;; *) bad "预签名 URL 必须是 https" "$url" ;; esac
  curl -s -o /dev/null -X PUT -T "$2" -H 'Content-Type: image/jpeg' "$url"
  echo "$key"
}
FRONT_KEY=$(upload front test-fixtures/faces/01-round.jpg)
[ -n "$FRONT_KEY" ] && ok "正面照直传 OSS（https 预签名）" || bad "正面照直传"

R=$(curl -s -b "$J" -X POST "$B/photos" -H 'content-type: application/json' \
  -d "{\"photoType\":\"front\",\"storageKey\":\"$FRONT_KEY\",\"faceMetrics\":{\"classification\":{\"faceShape\":{\"value\":\"round\",\"confidence\":\"high\",\"evidence\":{\"widthToHeight\":0.92}},\"hairline\":{\"value\":\"normal\"},\"hairVolume\":{\"value\":\"medium\"}}}}")
[ -n "$(echo "$R" | jqf photoId)" ] && ok "登记正面照 + faceMetrics" || bad "登记正面照" "$R"

R=$(curl -s -b "$J" -X POST "$B/photos" -H 'content-type: application/json' -d "{\"photoType\":\"front\",\"storageKey\":\"$FRONT_KEY\",\"faceMetrics\":{\"faceShape\":\"round\"}}")
[ "$(echo "$R" | jqf error)" = "validation_failed" ] && ok "错误 faceMetrics 形状被 422 拦住" || bad "faceMetrics 校验失效" "$R"

R=$(curl -s -b "$J" "$B/face-shape/computed")
[ "$(echo "$R" | jqf faceShape)" = "round" ] && ok "读回计算脸型 + 支撑比值" || bad "读回脸型" "$R"
curl -s -b "$J" -X POST "$B/face-shape/confirm" -H 'content-type: application/json' -d '{"confirmedFaceShape":"round"}' -o /dev/null
ok "用户确认脸型"

printf "\n=== 3. 意向两层审核 ===\n"
R=$(curl -s -b "$J" -X POST "$B/intake/hair-intent" -H 'content-type: application/json' -d '{"hasPreference":true,"preferenceText":"想剪个碎盖，显得精神一点"}')
[ "$(echo "$R" | jqf accepted)" = "true" ] && ok "正常意向通过（归一化=$(echo "$R" | jqf normalizedStyleTag)，第二层已审=$(echo "$R" | jqf secondLayerReviewed)）" || bad "正常意向" "$R"

R=$(curl -s -b "$J" -X POST "$B/intake/hair-intent" -H 'content-type: application/json' -d '{"hasPreference":true,"preferenceText":"想把鼻子垫高一点"}')
[ "$(echo "$R" | jqf accepted)" = "false" ] && ok "医美类请求被拒（reason=$(echo "$R" | jqf reason)）" || bad "医美类请求未被拦" "$R"

# 重新提交正常意向，确保落库的是通过的那条
curl -s -b "$J" -X POST "$B/intake/hair-intent" -H 'content-type: application/json' -d '{"hasPreference":true,"preferenceText":"想剪个碎盖，显得精神一点"}' -o /dev/null

printf "\n=== 4. 异步分析（HTTP → 队列 → worker → 编排器 → step）===\n"
R=$(curl -s -b "$J" -X POST "$B/analysis-jobs" -H "Idempotency-Key: smoke-analysis-$(date +%s)")
JID=$(echo "$R" | jqf jobId)
[ -n "$JID" ] && ok "创建 initial_analysis job" || { bad "创建 job" "$R"; printf "\n%s 通过 / %s 失败\n" "$pass" "$fail"; exit 1; }

printf "   轮询中（含真实视觉分析与图片生成，约 60-120s）…\n"
LAST=""
for i in $(seq 1 90); do
  S=$(curl -s -b "$J" "$B/analysis-jobs/$JID")
  ST=$(echo "$S" | jqf status)
  if [ "$ST" != "$LAST" ]; then printf "   → %s\n" "$ST"; LAST="$ST"; fi
  case "$ST" in completed|completed_partial|failed|cancelled) break ;; esac
  sleep 3
done

FINAL=$(curl -s -b "$J" "$B/analysis-jobs/$JID")
ST=$(echo "$FINAL" | jqf status)
case "$ST" in
  completed|completed_partial) ok "job 到达终态：$ST" ;;
  *) bad "job 未完成：$ST" "$(echo "$FINAL" | jqf errorReason)" ;;
esac

CAND=$(echo "$FINAL" | jqf partialResult.recommendation.candidates)
NCAND=$(node -e "try{const a=JSON.parse(process.argv[1]);console.log(Array.isArray(a)?a.length:0)}catch(e){console.log(0)}" "$CAND")
[ "$NCAND" -gt 0 ] && ok "S3 产出 $NCAND 个发型候选（含双审美评分）" || bad "S3 无候选" "$CAND"

CAPS=$(echo "$FINAL" | jqf partialResult.recommendation.capabilityStatus)
[ -n "$CAPS" ] && ok "能力状态随结果返回：$CAPS" || bad "缺 capabilityStatus"
case "$CAPS" in *multimodal_agent*) ok "知识来源标为多模态 Agent（不冒充数据匹配）";; *) bad "知识来源标注缺失" "$CAPS";; esac

# key 由 renderPreviewsStep 按 kind 拼出：hairstylePreviews / outfitPreviews
PREV=$(echo "$FINAL" | jqf partialResult.hairstylePreviews)
NPREV=$(node -e "try{const a=JSON.parse(process.argv[1]);console.log(Array.isArray(a)?a.length:0)}catch(e){console.log(0)}" "$PREV")
[ "$NPREV" -gt 0 ] && ok "S4 生成 $NPREV 张真实效果图" || bad "S4 无效果图" "$(echo "$FINAL" | jqf partialResult.missing)"
PEND=$(echo "$FINAL" | jqf partialResult.hairstylePreviewsPending)
[ "$PEND" = "0" ] && ok "待生成计数归零（无残留的重复计数器）" || bad "待生成计数未归零：$PEND"

PLANID=$(echo "$FINAL" | jqf partialResult.planId)
[ -n "$PLANID" ] && ok "方案已创建：$PLANID" || bad "方案未创建"

printf "\n=== 5. 方案端点 ===\n"
if [ -n "$PLANID" ]; then
  R=$(curl -s -b "$J" "$B/plans/current")
  [ -n "$(echo "$R" | jqf planId)" ] && ok "GET /plans/current" || bad "GET /plans/current" "$R"

  printf "\n=== 6. 两步约束选择（决策 3）===\n"
  # 先证明过滤引擎不能被绕过：提交一个未出现在候选里的条目
  R=$(curl -s -b "$J" -X POST "$B/plans/$PLANID/select-style" -H 'content-type: application/json' -d '{"candidateId":"not-a-real-candidate"}')
  case "$(echo "$R" | jqf error)" in
    not_found|not_owned) ok "伪造 candidateId 被拒（归属校验生效）";;
    *) bad "伪造 candidateId 未被拒" "$R";;
  esac

  PICK=$(echo "$CAND" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)[0].candidateId)}catch(e){console.log('')}})")
  R=$(curl -s -b "$J" -X POST "$B/plans/$PLANID/select-style" -H 'content-type: application/json' -d "{\"candidateId\":\"$PICK\"}")
  [ "$(echo "$R" | jqf ok)" = "true" ] && ok "选定发型：$(echo "$R" | jqf nameZh)" || bad "选定发型失败" "$R"

  printf "\n=== 7. 穿搭预览（无全身照 → 降级，零生成成本）===\n"
  R=$(curl -s -b "$J" -X POST "$B/plans/$PLANID/outfit-previews" -H "Idempotency-Key: smoke-outfit-$(date +%s)")
  OJID=$(echo "$R" | jqf jobId)
  [ -n "$OJID" ] && ok "创建 outfit_preview_generation job" || bad "创建穿搭 job" "$R"
  for i in $(seq 1 40); do
    S=$(curl -s -b "$J" "$B/analysis-jobs/$OJID"); ST=$(echo "$S" | jqf status)
    case "$ST" in completed|completed_partial|failed) break ;; esac
    sleep 2
  done
  OF=$(curl -s -b "$J" "$B/analysis-jobs/$OJID")
  MODE=$(echo "$OF" | jqf partialResult.outfit.mode)
  [ "$MODE" = "text_and_reference_only" ] && ok "无全身照正确降级（mode=${MODE}，不伪造全身照）" || bad "降级模式异常：$MODE" "$(echo "$OF" | jqf errorReason)"
  NOTICE=$(echo "$OF" | jqf partialResult.outfit.degradedNotice)
  [ -n "$NOTICE" ] && ok "降级已明确告知用户原因" || bad "降级缺少告知文案"
  OPREV=$(echo "$OF" | jqf partialResult.outfit.previews)
  OPICK=$(echo "$OPREV" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)[0].candidateId)}catch(e){console.log('')}})")
  if [ -n "$OPICK" ]; then
    R=$(curl -s -b "$J" -X POST "$B/plans/$PLANID/select-style" -H 'content-type: application/json' -d "{\"candidateId\":\"$OPICK\"}")
    [ "$(echo "$R" | jqf ok)" = "true" ] && ok "从降级文字候选选定穿搭：$(echo "$R" | jqf nameZh)" || bad "选定穿搭失败" "$R"
  else
    bad "穿搭降级未返回可选择的文字候选" "$OF"
  fi

  printf "\n=== 8. 方案落地 S5（零生成成本）===\n"
  R=$(curl -s -b "$J" -X POST "$B/plans/$PLANID/materialize" -H "Idempotency-Key: smoke-mat-$(date +%s)")
  MJID=$(echo "$R" | jqf jobId)
  [ -n "$MJID" ] && ok "创建 plan_materialization job" || bad "创建落地 job" "$R"
  for i in $(seq 1 40); do
    S=$(curl -s -b "$J" "$B/analysis-jobs/$MJID"); ST=$(echo "$S" | jqf status)
    case "$ST" in completed|completed_partial|failed) break ;; esac
    sleep 2
  done
  MF=$(curl -s -b "$J" "$B/analysis-jobs/$MJID")
  NT=$(echo "$MF" | jqf partialResult.materialization.totalTasks)
  [ -n "$NT" ] && [ "$NT" != "0" ] && ok "S5 落地 $NT 个任务到四阶段" || bad "S5 未产出任务" "$(echo "$MF" | jqf errorReason)"
  STAGES=$(echo "$MF" | jqf partialResult.materialization.stages)
  [ -n "$STAGES" ] && ok "阶段分布：$STAGES" || bad "缺阶段分布"

  R=$(curl -s -b "$J" "$B/plans/$PLANID")
  NSTAGE=$(echo "$R" | jqf stages | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).length)}catch(e){console.log(0)}})")
  [ "$NSTAGE" = "4" ] && ok "GET /plans/:id 返回四个阶段" || bad "阶段数异常：$NSTAGE"
fi

printf "\n%s 通过 / %s 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
