import { createHash } from "node:crypto";

export type SnapshotSource = {
  id: string;
  fileName: string;
  contents: string;
};

export type SnapshotValidatorResult = {
  id: string;
  version: string;
  passed: boolean;
  /** A failed readiness gate is recorded for honest degradation, not a build failure. */
  readinessGate?: boolean;
};

export type CatalogSnapshotManifest = {
  manifestVersion: "recommendation-catalog-snapshot-v1";
  builtAt: string;
  sources: Record<string, {
    fileName: string;
    /** SHA-256 of the validated client source bytes, retained for deployment audit. */
    datasetVersion: string;
    sha256: string;
    /** Hash of canonical JSON, stable across TypeScript's deployment JSON copy. */
    snapshotSha256: string;
  }>;
  validators: Record<string, SnapshotValidatorResult>;
};

type CreateManifestInput = {
  sources: SnapshotSource[];
  validators: SnapshotValidatorResult[];
  builtAt?: string;
};

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function snapshotSha256(contents: string): string {
  return sha256(JSON.stringify(JSON.parse(contents)));
}

function datasetVersion(contents: string): string {
  const parsed: unknown = JSON.parse(contents);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const row = parsed as Record<string, unknown>;
    for (const key of ["datasetVersion", "schemaVersion"] as const) {
      if (typeof row[key] === "string" && row[key].trim()) return row[key];
    }
  }
  // Some established client catalogs are top-level arrays. A content-derived
  // version is auditable without introducing a server-maintained second value.
  return `content-sha256:${snapshotSha256(contents)}`;
}

function assertSafeFileName(fileName: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/i.test(fileName)) {
    throw new Error(`Snapshot source has unsafe file name: ${fileName}`);
  }
}

function indexValidators(validators: SnapshotValidatorResult[]): Record<string, SnapshotValidatorResult> {
  const indexed: Record<string, SnapshotValidatorResult> = {};
  for (const validator of validators) {
    if (!validator.id || !validator.version) throw new Error("Snapshot validator needs an id and version");
    if (indexed[validator.id]) throw new Error(`Duplicate snapshot validator: ${validator.id}`);
    if (!validator.readinessGate && !validator.passed) {
      throw new Error(`Required validator ${validator.id} has not passed`);
    }
    indexed[validator.id] = { ...validator };
  }
  if (Object.keys(indexed).length === 0) throw new Error("Snapshot needs validator results");
  return indexed;
}

export function createCatalogSnapshotManifest(input: CreateManifestInput): CatalogSnapshotManifest {
  const sources: CatalogSnapshotManifest["sources"] = {};
  const fileNames = new Set<string>();
  for (const source of input.sources) {
    if (!source.id || !source.contents) throw new Error("Snapshot source needs an id and contents");
    assertSafeFileName(source.fileName);
    if (sources[source.id]) throw new Error(`Duplicate snapshot source: ${source.id}`);
    if (fileNames.has(source.fileName)) throw new Error(`Duplicate snapshot file: ${source.fileName}`);
    // Invalid JSON must fail before it can become a deployment artifact.
    JSON.parse(source.contents);
    sources[source.id] = {
      fileName: source.fileName,
      datasetVersion: datasetVersion(source.contents),
      sha256: sha256(source.contents),
      snapshotSha256: snapshotSha256(source.contents),
    };
    fileNames.add(source.fileName);
  }
  if (Object.keys(sources).length === 0) throw new Error("Snapshot needs at least one source");

  return {
    manifestVersion: "recommendation-catalog-snapshot-v1",
    builtAt: input.builtAt ?? new Date().toISOString(),
    sources,
    validators: indexValidators(input.validators),
  };
}

export function verifyCatalogSnapshot(input: {
  manifest: CatalogSnapshotManifest;
  sources: Record<string, string>;
}): void {
  if (input.manifest.manifestVersion !== "recommendation-catalog-snapshot-v1") {
    throw new Error(`Unsupported catalog snapshot manifest: ${input.manifest.manifestVersion}`);
  }
  indexValidators(Object.values(input.manifest.validators));
  const expectedFiles = new Set(Object.values(input.manifest.sources).map((source) => source.fileName));
  for (const [id, source] of Object.entries(input.manifest.sources)) {
    const contents = input.sources[source.fileName];
    if (contents === undefined) throw new Error(`Snapshot source missing: ${id} (${source.fileName})`);
    if (snapshotSha256(contents) !== source.snapshotSha256) throw new Error(`Snapshot source hash mismatch: ${id}`);
    if (datasetVersion(contents) !== source.datasetVersion) {
      throw new Error(`Snapshot source version mismatch: ${id}`);
    }
  }
  for (const fileName of Object.keys(input.sources)) {
    if (!expectedFiles.has(fileName)) throw new Error(`Snapshot contains unmanifested source: ${fileName}`);
  }
}
