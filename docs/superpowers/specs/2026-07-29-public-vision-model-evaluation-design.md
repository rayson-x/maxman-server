# Public Vision Model Evaluation Design

## Goal

Provide a one-off, publicly reachable questionnaire at `/model-evaluation` that
lets anonymous visitors rate how well currently usable vision models understand
the same twenty repository-owned hairstyle benchmark images.

## Scope

- Use exactly twenty allowlisted images from
  `server/benchmark-assets/face-shape-hairstyle-matrix-20260727/`.
- Include only providers that pass a live image-input probe at deployment time:
  Zhipu `glm-4v-flash`, `glm-4.6v`, `glm-5v-turbo`, and Qwen
  `qwen-vl-plus`. Tencent Hunyuan is displayed as unavailable while its
  credential is rejected and receives no evaluation requests.
- Run the fixed model-by-image matrix once on the server. Browser visitors
  never invoke model providers and never upload photos.
- Use the existing anonymous device session to persist one visitor's ratings
  and aggregate only anonymous scores.
- Record every benchmark call through the provider cost ledger, including its
  reported token usage and price state.

This is an internal one-off demo, not a general user image-analysis feature,
model-management console, or public upload service.

## Non-goals

- No user-supplied image upload, no access to production user photos, and no
  use of the face-shape result as model ground truth.
- No account login, admin token, payment, or generic benchmark configuration
  UI.
- No automatic selection of the production default model from a small sample.

## Sample set

The server owns a checked-in manifest of twenty image paths. The manifest is
stratified across the seven face-shape baseline images and thirteen distinct
hairstyle-effect images so a single look does not dominate the scores. The
manifest stores a stable sample id, a path relative to the benchmark root, and
the optional hairstyle label used only for post-hoc analysis; the label is not
shown while a visitor rates responses.

The image-serving endpoint resolves a sample id through this manifest and
never accepts arbitrary filesystem paths. It returns only the image bytes and
appropriate media type for an allowlisted asset.

## Model run and persistence

A run has a fixed sample manifest, a fixed list of model descriptors, status,
and timestamps. A response belongs to one run, sample, and model descriptor;
it stores raw response text, normalized structured answer when valid, latency,
provider usage, provider-call id, and failure detail.

The server creates the default run when it is absent and executes the 20 × N
matrix in the background text-analysis queue. A retry only runs missing or
failed response rows, and an idempotency key prevents duplicated provider
calls. Provider calls use a dedicated `model_evaluation` operation so their
tokens and cost can be filtered separately from customer-facing analysis.

The shared prompt asks for bounded JSON fields: hairstyle description,
forehead coverage, visible hair texture or length, uncertainty, and a short
non-diagnostic rationale. It explicitly prohibits age, attractiveness,
medical, gender-identity, and face-shape conclusions. A malformed answer is
retained as raw output and shown to raters as an output-quality failure.

## Public questionnaire

`/model-evaluation` first ensures the existing device session. It displays one
sample and the completed responses in randomized order without model names.
For each response, the visitor rates:

1. Hairstyle recognition accuracy, from 1 to 5.
2. Forehead-coverage judgment accuracy, from 1 to 5.
3. Recommendation usefulness, from 1 to 5.
4. Whether the response contains an out-of-scope or unsafe conclusion, yes or
   no.

Each rating is unique by `(device session user, run response)`. Revisiting the
page restores that visitor's selections; submitting changes updates the same
row rather than increasing aggregate counts. Once all available responses for
a sample are rated, the page reveals the corresponding model names and a
sample-level comparison. Failed or unavailable models are shown distinctly and
are not presented as scoreable answers.

The public summary contains only aggregate counts, per-question averages,
unsafe-response rate, average latency, and provider-usage/cost totals. It
never exposes session identifiers, raw user records, provider credentials, or
private image URLs.

## API boundary

The server exposes a narrowly scoped public evaluation API:

- Read the default run's status, allowlisted samples, blinded responses, and
  public aggregate summary.
- Read one allowlisted sample image by sample id.
- Upsert the current anonymous session's numeric rating for a response.

There is deliberately no public endpoint that accepts an image, prompt,
provider name, model id, filesystem path, or run creation request.

## Error handling and privacy

The page can be viewed while a run is still pending and refreshes results as
they complete. Provider failure produces a visible unavailable card with a
non-sensitive reason; it does not block other models or samples. A missing
session prevents rating submission but does not leak another visitor's work.

Only repository-owned benchmark assets are sent to configured model providers.
No new image retention is introduced. The existing device-session deletion
flow cascades the visitor's rating rows.

## Verification and deployment

Tests cover manifest traversal rejection, response-order blinding, one-rating
per session semantics, aggregate calculations, provider-failure isolation,
and cost-ledger attribution. A provider probe identifies usable models before
the run starts. Deployment runs migrations, launches the existing API and
worker, starts the one-off benchmark run, and verifies the public page can
load results and save a session rating.
