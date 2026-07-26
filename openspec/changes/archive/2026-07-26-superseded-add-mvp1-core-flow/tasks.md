> 范围说明：本清单只覆盖 `server/` 目录下的服务端实现。客户端（Web）页面/组件的实现任务由客户端团队在各自的设计文档（`docs/mvp-web-ui-design.md`）和独立任务清单中跟踪，不在本文档重复列出，避免两边脱节。

## 1. Project Scaffolding
- [ ] 1.1 Initialize `server/` as its own Node.js/TypeScript project (package.json, tsconfig) — independent of any client package, per the repo's server/client directory separation convention
- [ ] 1.2 Scaffold Fastify server with routes/services/providers/workflows/repositories/jobs layering
- [ ] 1.3 Set up Prisma with PostgreSQL connection, initial `schema.prisma`
- [ ] 1.4 Set up Redis + BullMQ with three queues: `moderation`, `text-analysis`, `image-generation`
- [ ] 1.5 Set up Mastra project structure for the analysis/generation workflows
- [ ] 1.6 Configure object storage client (OSS/COS) with private bucket + presigned URL generation

## 2. Data Model (Prisma schema)
- [ ] 2.1 `User` (phone nullable, device_session_id, birth_date, age_confirmed_18plus)
- [ ] 2.2 `ConsentRecord`
- [ ] 2.3 `AppearanceProfile`
- [ ] 2.4 `Event`
- [ ] 2.5 `UserPhoto` (with `face_metrics` json field)
- [ ] 2.6 `AppearancePlan`
- [ ] 2.7 `Stage`
- [ ] 2.8 `StageTask` — no `task_date`; fields: `priority`(core/optional), `evidence_basis`(visual_detected/self_reported/general_best_practice), `task_type`(simple/guided_selection), `selection_status`(not_applicable/pending_selection/selected), `candidate_style_tags`(json array, nullable), `style_tag`(nullable), `change_description`, `sort_order`
- [ ] 2.9 `ChangeManifestEntry` (with `source_task_id` nullable FK back to `StageTask`)
- [ ] 2.10 `TargetImage`
- [ ] 2.11 `AnalysisJob` (job_type, status state machine, plan_id/stage_id nullable FKs)
- [ ] 2.12 `WorkflowRun` (with `job_id` FK back to `AnalysisJob`)
- [ ] 2.13 `StyleReferenceGuide` (domain, style_tag, title, reference_url, reference_type, summary_text, updated_at) — human-curated seed table, see design.md decision 13
- [ ] 2.14 `CandidateTaskCatalog` (domain, method_name, description, evidence_basis, est_time, est_cost_range, reversibility, risk_level, risk_note, applicable_stage_range, visual_benefit_level, is_recommended, exclusion_reason) — human-curated seed table, see design.md decision 15
- [ ] 2.15 Run initial migration against a fresh database

## 3. Anonymous Session (spec: anonymous-session)
- [ ] 3.1 `POST /auth/device-session` endpoint: idempotent explicit session issuance (returns existing session if valid one already present), sets long-lived cookie
- [ ] 3.2 Fastify middleware/hook: read/validate `device_session_id` cookie on all other requests, attach `User` to request context

## 4. Questionnaire Intake (spec: intake-questionnaire)
- [ ] 4.1 `POST /questionnaire/basic` endpoint + validation schema
- [ ] 4.2 `POST /questionnaire/full` endpoint + validation schema (track branching, domain selection/acceptance, budget)
- [ ] 4.3 Structural contradiction validation logic

## 5. Photo Intake (spec: photo-intake)
- [ ] 5.1 `POST /photos/consent` endpoint, versioned consent text storage
- [ ] 5.2 `POST /photos` endpoint with presigned upload flow + storage-complete callback registration
- [ ] 5.3 Accept a `face_metrics` JSON payload alongside `POST /photos` and persist to `UserPhoto.face_metrics` (client-side MediaPipe computation itself is out of scope for this proposal — see client design doc)

## 6. Content Moderation (spec: content-moderation)
- [ ] 6.1 `ImageModerationProvider` implementation (input moderation) wired to `moderation` queue
- [ ] 6.2 `TextModerationProvider` implementation for questionnaire text
- [ ] 6.3 Output moderation step wired into generation pipeline
- [ ] 6.4 Deterministic rule-based backstop (hard-coded red lines)

## 7. Appearance Analysis Orchestration (spec: appearance-analysis)
- [ ] 7.1 `AnalysisJob` repository + state machine transitions
- [ ] 7.2 `POST /analysis-jobs` endpoint (validates completeness, enqueues to `text-analysis` queue)
- [ ] 7.3 `GET /analysis-jobs/:id` polling endpoint
- [ ] 7.4 Mastra workflow: input moderation → vision analysis → profile merge → parallel domain plans → priority scoring → text diagnosis
- [ ] 7.5 `VisionAnalysisProvider`, `TextPlanningProvider` implementations (provider abstraction + stub/mock concrete backend, real vendor TBD per design.md Open Questions)
- [ ] 7.5a Seed `CandidateTaskCatalog` with the 26 researched transformation methods (8 domains), including `is_recommended=false` entries with `exclusion_reason` for methods flagged as low-evidence (mewing, jawline exercisers, facial yoga)
- [ ] 7.5b `TextPlanningProvider` candidate-selection logic: select + score only from `CandidateTaskCatalog` entries with `is_recommended=true`, matched against questionnaire/vision-analysis results; no free-form method generation
- [ ] 7.6 Fixed weighted-formula priority scoring service (server-configurable weights; start with equal weights per design.md Open Questions)
- [ ] 7.6a `evidence_basis` classification step (visual_detected/self_reported/general_best_practice) applied as a pre-scoring filter; enforce general_best_practice → always optional; value inherited from the matched `CandidateTaskCatalog` entry, not independently re-derived
- [ ] 7.7 `WorkflowRun` persistence (cost, latency, versions, retry_count)
- [ ] 7.8 Worker process entrypoint separate from Fastify API process

## 8. Appearance Plan (spec: appearance-plan)
- [ ] 8.1 `GET /plans/:id` endpoint (no lock gating in MVP1, full content returned, includes all stages' tasks in one payload — no separate per-stage tasks endpoint)
- [ ] 8.1a `GET /plans/current` alias — resolves the session's single active AppearancePlan and delegates to the same handler as `GET /plans/:id`
- [ ] 8.2 `POST /plans/:id/stages/:stageId/tasks/:taskId/status` endpoint with core-task-not-skippable rule
- [ ] 8.3 Stage unlock evaluation service (ALL core StageTasks in the stage marked done; optional tasks excluded entirely from the decision; computed live from StageTask query, no cached counter)
- [ ] 8.4 Stage-unlock trigger: enqueue `stage_unlock_generation` AnalysisJob on threshold met
- [ ] 8.5 Seed `StyleReferenceGuide` table with initial style tags (微碎盖/寸头/飞机头/背头/纹理烫) and curated reference links/summaries
- [ ] 8.6 `style_tag` classification step in TextPlanningProvider output + backend lookup/attach logic (fallback to text-only when no match)
- [ ] 8.7 `task_type`/`selection_status`/`candidate_style_tags` fields on StageTask generation logic; `POST /plans/:id/stages/:stageId/tasks/:taskId/select` endpoint (updates selection_status only, no ChangeManifestEntry, no status change)

## 9. Target Image Generation (spec: target-image-generation)
- [ ] 9.1 `ImageEditProvider` implementation (baseline photo + ChangeManifest snapshot input; stub/mock backend, real vendor TBD)
- [ ] 9.2 `ChangeManifestEntry` auto-creation on StageTask completion (no LLM call)
- [ ] 9.3 Two image types per stage (face_hair, full_body_outfit) generation logic
- [ ] 9.4 Identity/body preservation constraints in generation prompt + automated quality-check step
- [ ] 9.5 `POST /plans/:id/target-images/regenerate` endpoint (user_regeneration, no quota check in MVP1)
- [ ] 9.6 `POST /plans/:id/recheck` endpoint (progress_recheck job, plan_version increment in place)
- [ ] 9.7 Wire `image-generation` queue with concurrency limits

## 10. Data Privacy (spec: data-privacy)
- [ ] 10.1 `DELETE /me/photos/:id`, `/me/photos`, `/me/profile`, `/me` endpoints (immediate `pending` response). MVP1 note: no client-facing entry point calls these yet (the "我的" tab was cut, see mvp-plan.md); these endpoints exist for internal/support-operated deletion requests and for the client to wire up later.
- [ ] 10.2 Background deletion queue job: object storage cleanup + cascading DB cleanup + redacted log references
- [ ] 10.3 AI-generated content labeling: on-page label data returned with `TargetImage` responses, export watermark applied, AI-generation marker written into exported file metadata

## 11. Integration & Validation
- [ ] 11.1 End-to-end API-level test script: questionnaire → photo upload → full_analysis → stage 0 unlock → task completion → stage 1 unlock → regenerate image → progress recheck → account deletion (calls endpoints directly; no client UI required for this proposal)
- [ ] 11.2 Load-test the `image-generation` queue concurrency limit under concurrent regeneration requests
- [ ] 11.3 Verify quality-check retry-once-then-fail path with a forced-failure test double provider
- [ ] 11.4 `openspec validate add-mvp1-core-flow --strict`
