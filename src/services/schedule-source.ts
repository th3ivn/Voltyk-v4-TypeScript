import type { RepoSourceConfig } from '../config/runtime.js';
import type { RegionScheduleImage, ScheduleSnapshot } from '../types/domain.js';

interface GitTreeResponse {
  tree?: Array<{ path?: string; type?: string }>;
}

interface GitBranchResponse {
  commit?: {
    commit?: {
      committer?: {
        date?: string;
      };
    };
  };
}

interface QueueRecordInput {
  regionId?: unknown;
  queueLabel?: unknown;
  imageUrl?: unknown;
  image?: unknown;
  imagePath?: unknown;
  statusText?: unknown;
  status?: unknown;
}

interface RegionFilePayload {
  regionId?: unknown;
  queues?: unknown;
}

interface NormalizedRegionRecord {
  regionId: string;
  queueLabel: string;
  imageUrl: string;
  statusText: string;
}

const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Voltyk-v4-TypeScript/schedule-source',
} satisfies Record<string, string>;

export class ScheduleSource {
  constructor(private readonly sourceConfig: RepoSourceConfig) {
    validateSourceConfig(sourceConfig);
  }

  async fetchSnapshot(): Promise<ScheduleSnapshot> {
    const [updatedAtUnix, entries] = await Promise.all([this.fetchRepoUpdatedAtUnix(), this.fetchDataEntries()]);

    const regions: RegionScheduleImage[] = entries.map((entry) => ({
      ...entry,
      updatedAtUnix,
    }));

    if (regions.length === 0) {
      throw new Error('Schedule source has no valid regions');
    }

    return { updatedAtUnix, regions };
  }

  async fetch(): Promise<RegionScheduleImage[]> {
    const snapshot = await this.fetchSnapshot();
    return snapshot.regions;
  }

  private async fetchRepoUpdatedAtUnix(): Promise<number> {
    const branchUrl = `https://api.github.com/repos/${this.sourceConfig.owner}/${this.sourceConfig.repo}/branches/${this.sourceConfig.branch}`;
    const branch = await this.fetchJson<GitBranchResponse>(branchUrl);

    const commitDate = branch.commit?.commit?.committer?.date;
    if (typeof commitDate !== 'string') {
      throw new Error('Schedule source branch payload has no commit date');
    }

    const updatedAtUnix = Math.floor(new Date(commitDate).getTime() / 1000);
    if (!Number.isFinite(updatedAtUnix) || updatedAtUnix <= 0) {
      throw new Error('Schedule source has invalid commit date');
    }

    return updatedAtUnix;
  }

  private async fetchDataEntries(): Promise<NormalizedRegionRecord[]> {
    const filePaths = await this.listDataFilePaths();
    const uniqueEntries = new Map<string, NormalizedRegionRecord>();

    for (const filePath of filePaths) {
      const payload = await this.fetchJson<unknown>(this.buildRawUrl(filePath));
      const regionFallback = regionIdFromDataPath(filePath, this.sourceConfig.dataBasePath);
      const records = parseRecordsFromDataFile(payload, regionFallback, this.sourceConfig);

      for (const record of records) {
        uniqueEntries.set(`${record.regionId}:${record.queueLabel}`, record);
      }
    }

    return [...uniqueEntries.values()];
  }

  private async listDataFilePaths(): Promise<string[]> {
    const treeUrl = `https://api.github.com/repos/${this.sourceConfig.owner}/${this.sourceConfig.repo}/git/trees/${this.sourceConfig.branch}?recursive=1`;
    const tree = await this.fetchJson<GitTreeResponse>(treeUrl);

    const dataBasePath = trimSlashes(this.sourceConfig.dataBasePath);

    return (Array.isArray(tree.tree) ? tree.tree : [])
      .filter((node) => node.type === 'blob' && typeof node.path === 'string')
      .map((node) => node.path as string)
      .filter((path) => path.startsWith(`${dataBasePath}/`) && path.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: API_HEADERS });
    if (!response.ok) {
      throw new Error(`Failed to fetch schedule source: ${response.status} (${url})`);
    }

    return (await response.json()) as T;
  }

  private buildRawUrl(path: string): string {
    const template = this.sourceConfig.rawUrlTemplate ?? 'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}';

    return template
      .replace('{owner}', this.sourceConfig.owner)
      .replace('{repo}', this.sourceConfig.repo)
      .replace('{branch}', this.sourceConfig.branch)
      .replace('{path}', path);
  }
}

function parseRecordsFromDataFile(
  payload: unknown,
  regionFallback: string,
  sourceConfig: RepoSourceConfig,
): NormalizedRegionRecord[] {
  if (Array.isArray(payload)) {
    return payload
      .map((entry) => parseQueueRecord(entry, regionFallback, sourceConfig))
      .filter((entry): entry is NormalizedRegionRecord => entry !== null);
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const regionFile = payload as RegionFilePayload;

  if (Array.isArray(regionFile.queues)) {
    const regionFromFile = toNonEmptyString(regionFile.regionId) ?? regionFallback;
    return regionFile.queues
      .map((entry) => parseQueueRecord(entry, regionFromFile, sourceConfig))
      .filter((entry): entry is NormalizedRegionRecord => entry !== null);
  }

  const single = parseQueueRecord(payload, regionFallback, sourceConfig);
  return single ? [single] : [];
}

function parseQueueRecord(input: unknown, regionFallback: string, sourceConfig: RepoSourceConfig): NormalizedRegionRecord | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const record = input as QueueRecordInput;
  const regionId = toNonEmptyString(record.regionId) ?? regionFallback;
  const queueLabel = normalizeLabel(record.queueLabel);
  const statusText = toNonEmptyString(record.statusText) ?? toNonEmptyString(record.status);
  const imageRef =
    toNonEmptyString(record.imageUrl) ?? toNonEmptyString(record.imagePath) ?? toNonEmptyString(record.image);

  if (!regionId || !queueLabel || !statusText || !imageRef) {
    return null;
  }

  return {
    regionId,
    queueLabel,
    statusText,
    imageUrl: resolveImageUrl(imageRef, sourceConfig),
  };
}

function resolveImageUrl(imageRef: string, sourceConfig: RepoSourceConfig): string {
  if (imageRef.startsWith('https://') || imageRef.startsWith('http://')) {
    return imageRef;
  }

  const normalizedImagePath = trimSlashes(imageRef);
  const imagesBasePath = trimSlashes(sourceConfig.imagesBasePath);
  const path = normalizedImagePath.includes('/') ? normalizedImagePath : `${imagesBasePath}/${normalizedImagePath}`;

  const template = sourceConfig.rawUrlTemplate ?? 'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}';

  return template
    .replace('{owner}', sourceConfig.owner)
    .replace('{repo}', sourceConfig.repo)
    .replace('{branch}', sourceConfig.branch)
    .replace('{path}', path);
}

function regionIdFromDataPath(filePath: string, dataBasePath: string): string {
  const normalizedDataBasePath = trimSlashes(dataBasePath);
  const relativePath = filePath.startsWith(`${normalizedDataBasePath}/`)
    ? filePath.slice(normalizedDataBasePath.length + 1)
    : filePath;
  return relativePath.replace(/\.json$/i, '').replace(/\//g, '-');
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return toNonEmptyString(value);
}

function trimSlashes(input: string): string {
  return input.replace(/^\/+/, '').replace(/\/+$/, '');
}

function validateSourceConfig(sourceConfig: RepoSourceConfig): void {
  const requiredFields = [
    ['owner', sourceConfig.owner],
    ['repo', sourceConfig.repo],
    ['branch', sourceConfig.branch],
    ['dataBasePath', sourceConfig.dataBasePath],
    ['imagesBasePath', sourceConfig.imagesBasePath],
  ] as const;

  for (const [field, value] of requiredFields) {
    if (value.trim().length === 0) {
      throw new Error(`Schedule source config field "${field}" must be non-empty`);
    }
  }

  if (sourceConfig.rawUrlTemplate && !sourceConfig.rawUrlTemplate.includes('{path}')) {
    throw new Error('Schedule source rawUrlTemplate must include "{path}" placeholder');
  }
}
