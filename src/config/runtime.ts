export interface RepoSourceConfig {
  owner: string;
  repo: string;
  branch: string;
  dataBasePath: string;
  imagesBasePath: string;
  rawUrlTemplate?: string;
}

export const SCHEDULE_SOURCE_CONFIG: RepoSourceConfig = {
  owner: 'Baskerville42',
  repo: 'outage-data-ua',
  branch: 'main',
  dataBasePath: 'data',
  imagesBasePath: 'images',
};

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Admin IDs for runtime controls (/admin).
 * Leave empty to allow any user to open admin panel (Stage 1 fallback).
 */
export const ADMIN_USER_IDS = new Set<number>();
