import type { Db } from "mongodb";
import { z } from "zod";
import { Collections } from "../../connection/collections.js";
import { idOf } from "../keys.js";
import type { StoredConfigSnapshot, StoredVersionScore } from "./record-documents.js";

/** Quality scores of records, the summary per prompt version, and the config snapshots (#78). */

export async function saveScore(
  db: Db,
  recordId: string,
  judge: string,
  score: number,
  now: Date,
): Promise<void> {
  await db
    .collection(Collections.ExecutionScores)
    .insertOne({ recordId, judge, score, createdAt: now });
}

const Mean = z.object({ mean: z.number().nullable() });

/** The mean score of the records' scores; `null` when none is scored. */
export async function meanScoreOf(db: Db, recordIds: readonly string[]): Promise<number | null> {
  const [found] = await db
    .collection(Collections.ExecutionScores)
    .aggregate([
      { $match: { recordId: { $in: [...recordIds] } } },
      { $group: { _id: null, mean: { $avg: "$score" } } },
    ])
    .toArray();
  return found === undefined ? null : Mean.parse(found).mean;
}

const VersionScoreDocument = z.object({
  _id: z.string(),
  records: z.number(),
  scored: z.number(),
  total: z.number(),
  costUsd: z.number(),
});

/** Per prompt version, in the order first seen: records, scored ones, mean score, total cost. */
export async function versionScoresOf(db: Db, workflow: string): Promise<StoredVersionScore[]> {
  const found = await db
    .collection(Collections.ExecutionRecords)
    .aggregate([
      { $match: { bundle: workflow, status: { $ne: "running" } } },
      {
        $lookup: {
          from: Collections.ExecutionScores,
          localField: "_id",
          foreignField: "recordId",
          as: "scores",
        },
      },
      {
        $group: {
          _id: "$promptVersion",
          first: { $min: "$seq" },
          records: { $sum: 1 },
          scored: { $sum: { $size: "$scores" } },
          total: { $sum: { $sum: "$scores.score" } },
          costUsd: { $sum: "$costUsd" },
        },
      },
      { $sort: { first: 1 } },
    ])
    .toArray();
  return found.map((one) => {
    const version = VersionScoreDocument.parse(one);
    return {
      promptVersion: version._id,
      terns: version.records,
      scored: version.scored,
      meanScore: version.scored === 0 ? null : version.total / version.scored,
      costUsd: version.costUsd,
    };
  });
}

interface ConfigDocument {
  _id: string;
  workflow: string;
  version: string;
  hash: string;
  snapshot: string;
  firstSeen: Date;
}

const Config = z.object({ hash: z.string() });

/**
 * Keeps the snapshot the first time; `drift` when the version already has another hash of the
 * same length (a hash of another length is of an older hashing scheme: not comparable).
 */
export async function rememberConfig(
  db: Db,
  workflow: string,
  version: string,
  hash: string,
  snapshot: string,
  now: Date,
): Promise<{ readonly drift: boolean }> {
  const configs = db.collection<ConfigDocument>(Collections.ConfigVersions);
  const others = await configs.find({ workflow, version, hash: { $ne: hash } }).toArray();
  const drift = others.some((other) => Config.parse(other).hash.length === hash.length);
  const document = {
    _id: idOf(workflow, version, hash),
    workflow,
    version,
    hash,
    snapshot,
    firstSeen: now,
  };
  await configs.updateOne({ _id: document._id }, { $setOnInsert: document }, { upsert: true });
  return { drift };
}

const Snapshot = z.object({
  version: z.string(),
  hash: z.string(),
  snapshot: z.string(),
  firstSeen: z.date(),
});

export async function configSnapshotsOf(
  db: Db,
  workflow: string,
  version: string,
): Promise<StoredConfigSnapshot[]> {
  const found = await db
    .collection<ConfigDocument>(Collections.ConfigVersions)
    .find({ workflow, version })
    .sort({ firstSeen: 1 })
    .toArray();
  return found.map((one) => {
    const config = Snapshot.parse(one);
    return { ...config, firstSeen: config.firstSeen.toISOString() };
  });
}
