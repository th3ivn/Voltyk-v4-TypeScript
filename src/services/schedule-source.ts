import type { RegionScheduleImage, ScheduleSnapshot } from '../types/domain.js';

interface GitHubTreeNode {
  path: string;
  type: string;
}

interface GitHubTreeResponse {
  tree?: unknown;
}

interface GitHubBranchCommitResponse {
  commit?: {
    committer?: {
      date?: string;
    };
  };
}

interface RepositoryRef {
  owner: string;
  repo: string;
  branch: string;
}

type JsonRecord = Record<string, unknown>;

const GITHUB_API_BASE_URL = 'https://api.github.com';
const RAW_GITHUB_BASE_URL = 'https://raw.githubusercontent.com';
const GITHUB_ACCEPT_HEADER = 'application/vnd.github+json';
const USER_AGENT = 'Voltyk-v4-TypeScript/schedule-source';

export class ScheduleSource {
  private readonly repositoryRef: RepositoryRef;

  constructor(sourceJsonUrl: string) {
    this.repositoryRef = parseRepositoryRef(sourceJsonUrl);
  }

  async fetchSnapshot(): Promise<ScheduleSnapshot> {
    const [filePaths, updatedAtUnix] = await Promise.all([
      this.fetchDataFilePaths(),
      this.fetchSnapshotUpdatedAtUnix(),
    ]);

    if (filePaths.length === 0) {
      throw new Error('Repository snapshot has no schedule files under data/*.json');
    }

    const regions: RegionScheduleImage[] = [];

    for (const filePath of filePaths) {
      const payload = await this.fetchJsonRaw(filePath);
      const fileRegions = normalizeRegionRecords(payload, {
        filePath,
        updatedAtUnix,
        repositoryRef: this.repositoryRef,
      });
      regions.push(...fileRegions);
    }

    if (regions.length === 0) {
      throw new Error('Repository snapshot has no valid region schedule records');
    }

    return { updatedAtUnix, regions };
  }

  async fetch(): Promise<RegionScheduleImage[]> {
    const snapshot = await this.fetchSnapshot();
    return snapshot.regions;
  }

  private async fetchDataFilePaths(): Promise<string[]> {
    const treeUrl = `${GITHUB_API_BASE_URL}/repos/${this.repositoryRef.owner}/${this.repositoryRef.repo}/git/trees/${this.repositoryRef.branch}?recursive=1`;
    const treePayload = await this.fetchJsonApi(treeUrl);

    if (!treePayload || typeof treePayload !== 'object') {
      throw new Error('GitHub tree API returned non-object payload');
    }

    const tree = (treePayload as GitHubTreeResponse).tree;
    if (!Array.isArray(tree)) {
      throw new Error('GitHub tree API returned payload without tree[]');
    }

    return tree
      .filter((node): node is GitHubTreeNode => {
        if (!node || typeof node !== 'object') {
          return false;
        }

        const record = node as Partial<GitHubTreeNode>;
        return typeof record.path === 'string' && typeof record.type === 'string';
      })
      .filter((node) => node.type === 'blob' && node.path.startsWith('data/') && node.path.endsWith('.json'))
      .map((node) => node.path)
      .sort((left, right) => left.localeCompare(right));
  }

  private async fetchSnapshotUpdatedAtUnix(): Promise<number> {
    const commitUrl = `${GITHUB_API_BASE_URL}/repos/${this.repositoryRef.owner}/${this.repositoryRef.repo}/commits/${this.repositoryRef.branch}`;
    const commitPayload = await this.fetchJsonApi(commitUrl);

    if (!commitPayload || typeof commitPayload !== 'object') {
      throw new Error('GitHub commits API returned non-object payload');
    }

    const dateRaw = (commitPayload as GitHubBranchCommitResponse).commit?.committer?.date;
    if (typeof dateRaw !== 'string') {
      throw new Error('GitHub commits API payload has no commit.committer.date');
    }

    const unix = Math.floor(Date.parse(dateRaw) / 1000);
    if (!Number.isFinite(unix) || unix <= 0) {
      throw new Error(`Cannot parse commit date into unix time: ${dateRaw}`);
    }

    return unix;
  }

  private async fetchJsonApi(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Accept: GITHUB_ACCEPT_HEADER,
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} (${url})`);
    }

    return response.json();
  }

  private async fetchJsonRaw(filePath: string): Promise<unknown> {
    const fileUrl = `${RAW_GITHUB_BASE_URL}/${this.repositoryRef.owner}/${this.repositoryRef.repo}/${this.repositoryRef.branch}/${filePath}`;
    const response = await fetch(fileUrl, {
      headers: {
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch schedule data file: ${response.status} ${response.statusText} (${fileUrl})`);
    }

    return response.json();
  }
}

function parseRepositoryRef(sourceJsonUrl: string): RepositoryRef {
  let url: URL;

  try {
    url = new URL(sourceJsonUrl);
  } catch {
    throw new Error(`sourceJsonUrl is not a valid URL: ${sourceJsonUrl}`);
  }

  const pathParts = url.pathname.split('/').filter(Boolean);

  if (url.hostname === 'raw.githubusercontent.com') {
    if (pathParts.length < 3) {
      throw new Error(`Cannot parse GitHub raw URL (expected /owner/repo/branch/...): ${sourceJsonUrl}`);
    }

    const owner = pathParts[0];
    const repo = pathParts[1];
    const branch = pathParts[2];
    if (!owner || !repo || !branch) {
      throw new Error(`Cannot parse GitHub raw URL (missing owner/repo/branch): ${sourceJsonUrl}`);
    }

    return {
      owner,
      repo,
      branch,
    };
  }

  if (url.hostname === 'github.com') {
    if (pathParts.length >= 4 && pathParts[2] === 'tree') {
      const owner = pathParts[0];
      const repo = pathParts[1];
      const branch = pathParts[3];
      if (!owner || !repo || !branch) {
        throw new Error(`Cannot parse GitHub URL (missing owner/repo/branch): ${sourceJsonUrl}`);
      }

      return {
        owner,
        repo,
        branch,
      };
    }

    throw new Error(`Cannot parse GitHub URL (expected /owner/repo/tree/branch): ${sourceJsonUrl}`);
  }

  throw new Error(`Unsupported sourceJsonUrl host: ${url.hostname}`);
}

function normalizeRegionRecords(
  payload: unknown,
  context: { filePath: string; updatedAtUnix: number; repositoryRef: RepositoryRef },
): RegionScheduleImage[] {
  const topLevelRecords = extractTopLevelRecords(payload, context.filePath);
  const regions: RegionScheduleImage[] = [];

  for (const [index, topRecord] of topLevelRecords.entries()) {
    const topContext = `${context.filePath}[${index}]`;
    const regionId = readRequiredString(topRecord, ['regionId', 'region_id', 'region'], `${topContext}.regionId`);
    const rowItems = extractRows(topRecord, topContext);

    for (const [rowIndex, row] of rowItems.entries()) {
      const rowContext = `${topContext}.rows[${rowIndex}]`;
      const queueLabel = readRequiredString(row, ['queueLabel', 'queue_label', 'queue', 'group'], `${rowContext}.queueLabel`);
      const imagePathOrUrl = readRequiredString(row, ['imageUrl', 'image_url', 'image', 'imagePath', 'image_path'], `${rowContext}.imageUrl`);
      const statusText = readRequiredString(row, ['statusText', 'status_text', 'status'], `${rowContext}.statusText`);

      regions.push({
        regionId,
        queueLabel,
        imageUrl: resolveImageUrl(imagePathOrUrl, context.repositoryRef),
        statusText,
        updatedAtUnix: context.updatedAtUnix,
      });
    }
  }

  return regions;
}

function extractTopLevelRecords(payload: unknown, filePath: string): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.map((entry, index) => assertRecord(entry, `${filePath}[${index}]`));
  }

  if (payload && typeof payload === 'object') {
    return [payload as JsonRecord];
  }

  throw new Error(`Invalid JSON root in ${filePath}: expected object or array`);
}

function extractRows(regionRecord: JsonRecord, contextPath: string): JsonRecord[] {
  const rowsCandidate = firstDefined(regionRecord, ['rows', 'queues', 'items', 'schedules']);

  if (rowsCandidate === undefined) {
    return [regionRecord];
  }

  if (!Array.isArray(rowsCandidate)) {
    throw new Error(`Invalid field ${contextPath}: expected rows/queues/items/schedules to be an array`);
  }

  return rowsCandidate.map((row, index) => assertRecord(row, `${contextPath}.rows[${index}]`));
}

function resolveImageUrl(imagePathOrUrl: string, repositoryRef: RepositoryRef): string {
  if (/^https?:\/\//i.test(imagePathOrUrl)) {
    return imagePathOrUrl;
  }

  const trimmed = imagePathOrUrl.replace(/^\.\//, '').replace(/^\/+/, '');
  const normalizedPath = trimmed.startsWith('images/') ? trimmed : `images/${trimmed}`;

  return `${RAW_GITHUB_BASE_URL}/${repositoryRef.owner}/${repositoryRef.repo}/${repositoryRef.branch}/${normalizedPath}`;
}

function assertRecord(value: unknown, contextPath: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid structure in ${contextPath}: expected object`);
  }

  return value as JsonRecord;
}

function readRequiredString(record: JsonRecord, keys: string[], contextPath: string): string {
  const value = firstDefined(record, keys);

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid field ${contextPath}: expected non-empty string in one of [${keys.join(', ')}]`);
  }

  return value.trim();
}

function firstDefined(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
}
