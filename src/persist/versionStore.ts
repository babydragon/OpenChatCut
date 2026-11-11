// Version history (/api/versions): List of named snapshots saved by project, reused during recovery
// migrateProjectDoc verification. Share native server KV with projectStore.
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
import { partitionRecords, withPreservedRecords } from './recordPartition';
import type { ProjectDoc } from '../editor/types';

const versionsKey = (projectId: string) => `versions:${projectId}`;
export const MAX_AUTOMATIC_VERSIONS = 30;
/** One project's whole snapshot list is stored as a single entry, so it travels
 *  as ONE request body (the project-store HTTP transport caps a body at 64 MiB).
 *  A 4 MB document × 30 snapshots is ~120 MB of JSON: the count cap alone cannot
 *  keep the list writable, and every later write fails — which surfaced as
 *  "无法创建修改前版本，Agent 改动未应用" on every agent run. Keep the serialized
 *  list under this budget by dropping the OLDEST automatic snapshots; manual
 *  snapshots are never dropped. */
export const MAX_VERSION_PAYLOAD_BYTES = 48 * 1024 * 1024;
const mutationQueues = new Map<string, Promise<unknown>>();

export interface ProjectVersion {
  id: string;
  name: string;
  createdAt: number;
  automatic?: boolean;
  doc: ProjectDoc;
}

// Boundary verification: Persistent data is not trustworthy and should be verified before use (id/name/createdAt + doc is regulated by migrateProjectDoc).
function toValidVersion(v: unknown): ProjectVersion | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<ProjectVersion>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.createdAt !== 'number') return null;
  const doc = migrateProjectDoc(raw.doc);
  if (!doc) return null;
  return {
    // Unknown envelope fields pass through; only validated ones are replaced.
    ...raw,
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    automatic: raw.automatic === true,
    doc,
  };
}

/** Readable snapshots plus the entries this build cannot parse — a snapshot
 * written by a NEWER build reads as unparsable here, and the 30s automatic
 * save would otherwise erase it within minutes. */
async function readPartitioned(projectId: string) {
  return partitionRecords(await idbGet<unknown>(versionsKey(projectId)), toValidVersion);
}

async function readAll(projectId: string): Promise<ProjectVersion[]> {
  return (await readPartitioned(projectId)).valid;
}

/** Raw snapshots for conservative media-reference collection, including unreadable versions.
 * Unlike the display list, this read does not swallow storage errors. */
export function loadRawVersions(projectId: string): Promise<unknown> {
  return idbGet<unknown>(versionsKey(projectId));
}

/** All snapshots of the project, latest first. An empty array is returned on any failure (persistent data is not trusted).*/
export async function listVersions(projectId: string): Promise<ProjectVersion[]> {
  try {
    return (await readAll(projectId)).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `v_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

function sameDocument(left: ProjectDoc, right: ProjectDoc): boolean {
  const normalizedLeft = migrateProjectDoc(left);
  const normalizedRight = migrateProjectDoc(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}
function serializeMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(projectId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationQueues.set(projectId, current);
  return current.finally(() => {
    if (mutationQueues.get(projectId) === current) mutationQueues.delete(projectId);
  });
}

async function persistVersion(
  projectId: string,
  name: string,
  doc: ProjectDoc,
  automatic: boolean,
): Promise<ProjectVersion> {
  const version: ProjectVersion = {
    id: newId(),
    name: name.trim() || (automatic ? '自动保存' : '未命名版本'),
    createdAt: Date.now(),
    automatic,
    doc,
  };
  const { valid, opaque } = await readPartitioned(projectId);
  const next = [version, ...valid];
  const retainedAutomaticIds = new Set(
    next.filter((item) => item.automatic).slice(0, MAX_AUTOMATIC_VERSIONS).map((item) => item.id),
  );
  await idbSet(versionsKey(projectId), withPreservedRecords(
    fitPayloadBudget(
      next.filter((item) => !item.automatic || retainedAutomaticIds.has(item.id)),
      opaque,
    ),
    opaque,
  ));
  return version;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Serialized size of one record as `JSON.stringify` writes it, plus its separator. */
function recordBytes(record: unknown): number {
  return utf8Bytes(JSON.stringify(record)) + 1;
}

/** Drop the oldest automatic snapshots until the entry fits the transport budget.
 *  Index 0 is the snapshot just written; manual snapshots are always kept, so a
 *  project whose manual snapshots alone exceed the budget still writes (and the
 *  transport reports the real reason instead of silently losing them). */
function fitPayloadBudget(
  versions: readonly ProjectVersion[],
  opaque: readonly unknown[],
): ProjectVersion[] {
  const kept = [...versions];
  // Measured once per record: re-serializing inside the loop would be quadratic
  // on a list that is already tens of megabytes.
  const sizes = kept.map(recordBytes);
  let bytes = 1 + opaque.reduce<number>((total, record) => total + recordBytes(record), 0);
  for (const size of sizes) bytes += size;
  for (let index = kept.length - 1; index > 0 && bytes > MAX_VERSION_PAYLOAD_BYTES; index -= 1) {
    if (!kept[index].automatic) continue;
    bytes -= sizes[index];
    kept.splice(index, 1);
  }
  return kept;
}

/** Save the current project document as a named snapshot (pre-insert, latest first).*/
export function saveVersion(projectId: string, name: string, doc: ProjectDoc): Promise<ProjectVersion> {
  return serializeMutation(projectId, () => persistVersion(projectId, name, doc, false));
}

/** Save a deduplicated automatic snapshot while preserving every manual version. */
export function saveAutomaticVersion(
  projectId: string,
  name: string,
  doc: ProjectDoc,
): Promise<ProjectVersion | null> {
  return serializeMutation(projectId, async () => {
    const latest = (await readAll(projectId)).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest && sameDocument(latest.doc, doc)) return null;
    return persistVersion(projectId, name, doc, true);
  });
}

export function deleteVersion(projectId: string, id: string): Promise<void> {
  return serializeMutation(projectId, async () => {
    const { valid, opaque } = await readPartitioned(projectId);
    await idbSet(versionsKey(projectId), withPreservedRecords(
      valid.filter((v) => v.id !== id),
      opaque,
    ));
  });
}
