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
  constructor(private readonly sourceConfig: RepoSourceConfig) {}

  async fetchSnapshot(): Promise<ScheduleSnapshot> {
    const [updatedAtUnix, entries] = await Promise.all([this.fetchRepoUpdatedAtUnix(), this.fetchDataEntries()]);

    const regions: RegionScheduleImage[] = entries.map((entry) => ({
      ...entry,
      updatedAtUnix,
    }));

    if (regions.length === 0) {
      throw new Error('Schedule source has no valid regions');
    }

    return {
      updatedAtUnix,
      regions,
    };
  }

  async fetch(): Promise<RegionScheduleImage[]> {
    const snapshot = await this.fetchSnapshot();
    return snapshot.regions;
  }

  private async fetchRepoUpdatedAtUnix(): Promise<number> {
    const url = `https://api.github.com/repos/${this.sourceConfig.owner}/${this.sourceConfig.repo}/branches/${this.sourceConfig.branch}`;
    const json = await this.fetchJson<GitBranchResponse>(url);
    const dateIso = json.commit?.commit?.committer?.date;

    if (typeof dateIso !== 'string') {
      throw new Error('Schedule source branch payload has no commit date');
    }

    const unix = Math.floor(new Date(dateIso).getTime() / 1000);
    if (!Number.isFinite(unix) || unix <= 0) {
      throw new Error('Schedule source has invalid commit date');
    }

    return unix;
  }

  private async fetchDataEntries(): Promise<NormalizedRegionRecord[]> {
    const paths = await this.listDataFilePaths();
    const unique = new Map<string, NormalizedRegionRecord>();

    for (const filePath of paths) {
      const payload = await this.fetchJson<unknown>(this.buildRawUrl(filePath));
      const regionFallback = extractRegionFromPath(filePath, this.sourceConfig.dataBasePath);
      const records = normalizeSourcePayload(payload, regionFallback, this.sourceConfig, filePath);

      for (const record of records) {
        unique.set(`${record.regionId}:${record.queueLabel}`, record);
      }
    }

    return [...unique.values()];
  }

  private async listDataFilePaths(): Promise<string[]> {
    const url = `https://api.github.com/repos/${this.sourceConfig.owner}/${this.sourceConfig.repo}/git/trees/${this.sourceConfig.branch}?recursive=1`;
    const json = await this.fetchJson<GitTreeResponse>(url);

    const basePath = trimSlashes(this.sourceConfig.dataBasePath);
    const tree = Array.isArray(json.tree) ? json.tree : [];

    return tree
      .filter((node) => node.type === 'blob' && typeof node.path === 'string')
      .map((node) => node.path as string)
      .filter((path) => path.startsWith(`${basePath}/`) && path.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: API_HEADERS });
    if (!response.ok) {
      throw new Error(`Failed to fetch schedule source: ${response.status} (${url})`);
    }

    return (await response.json()) as T;
  }

  private buildRawUrl(filePath: string): string {
    const template = this.sourceConfig.rawUrlTemplate ?? 'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}';

    return template
      .replace('{owner}', this.sourceConfig.owner)
      .replace('{repo}', this.sourceConfig.repo)
      .replace('{branch}', this.sourceConfig.branch)
      .replace('{path}', filePath);
  }
}

function normalizeSourcePayload(
  payload: unknown,
  regionFallback: string,
  sourceConfig: RepoSourceConfig,
  filePath: string,
): NormalizedRegionRecord[] {
  const records: NormalizedRegionRecord[] = [];
  const visited = new Set<unknown>();
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const normalized = tryNormalizeRecord(current as Record<string, unknown>, regionFallback, sourceConfig, filePath);
    if (normalized) {
      records.push(normalized);
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return records;
}

function tryNormalizeRecord(
  record: Record<string, unknown>,
  regionFallback: string,
  sourceConfig: RepoSourceConfig,
  filePath: string,
): NormalizedRegionRecord | null {
  const queueLabel = pickFirstString(record, ['queueLabel', 'queue', 'queueName', 'group']);
  const statusText = pickFirstString(record, ['statusText', 'status', 'message', 'text']);
  const imageRef = pickFirstString(record, ['imageUrl', 'image', 'imagePath', 'image_file']);

  if (!queueLabel || !statusText || !imageRef) {
    return null;
  }

  const regionId = pickFirstString(record, ['regionId', 'region', 'regionSlug']) ?? regionFallback;
  if (!regionId) {
    return null;
  }

  return {
    regionId,
    queueLabel,
    statusText,
    imageUrl: resolveImageUrl(imageRef, sourceConfig, filePath),
  };
}

function resolveImageUrl(imageRef: string, sourceConfig: RepoSourceConfig, filePath: string): string {
  if (imageRef.startsWith('https://') || imageRef.startsWith('http://')) {
    return imageRef;
  }

  const normalizedImagePath = trimSlashes(imageRef);
  const imagesBasePath = trimSlashes(sourceConfig.imagesBasePath);
  const fullPath = normalizedImagePath.includes('/')
    ? normalizedImagePath
    : `${imagesBasePath}/${normalizedImagePath}`;

  const template = sourceConfig.rawUrlTemplate ?? 'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}';

  return template
    .replace('{owner}', sourceConfig.owner)
    .replace('{repo}', sourceConfig.repo)
    .replace('{branch}', sourceConfig.branch)
    .replace('{path}', fullPath);
}

function pickFirstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function extractRegionFromPath(filePath: string, dataBasePath: string): string {
  const cleanBase = trimSlashes(dataBasePath);
  const withoutPrefix = filePath.startsWith(`${cleanBase}/`) ? filePath.slice(cleanBase.length + 1) : filePath;
  const withoutExtension = withoutPrefix.replace(/\.json$/i, '');
  return trimSlashes(withoutExtension).replace(/\//g, '-');
}

function trimSlashes(input: string): string {
  return input.replace(/^\/+/, '').replace(/\/+$/, '');
}
