import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyManifestEvidence,
  classifyManifestVerification,
} from "./planRevisionService.js";

test("manifest verification stays unverified when no item-level evidence exists", () => {
  assert.equal(
    classifyManifestVerification("胡须剃干净", []),
    "unverified",
  );
  assert.equal(
    classifyManifestVerification("胡须剃干净", undefined),
    "unverified",
  );
});

test("a complete non-empty undone list rolls back matches and verifies non-matches", () => {
  const undone = ["胡须仍未剃干净"];
  assert.equal(
    classifyManifestVerification("胡须剃干净", undone),
    "rolled_back",
  );
  assert.equal(
    classifyManifestVerification("发型调整为微碎盖", undone),
    "verified",
  );
});

test("item-level evidence maps only explicit verdicts to ledger state", () => {
  const evidence = [
    { entryId: "hair", status: "completed" as const, reason: "发型一致" },
    { entryId: "beard", status: "not_completed" as const, reason: "仍有胡须" },
    { entryId: "outfit", status: "uncertain" as const, reason: "照片未拍到全身" },
  ];

  assert.equal(classifyManifestEvidence("hair", evidence), "verified");
  assert.equal(classifyManifestEvidence("beard", evidence), "rolled_back");
  assert.equal(classifyManifestEvidence("outfit", evidence), "unverified");
  assert.equal(classifyManifestEvidence("missing", evidence), "unverified");
});
