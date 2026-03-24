export const SOURCE_JSON_URL = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/voltyk-source.json';

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Admin IDs for runtime controls (/admin).
 * Leave empty to allow any user to open admin panel (Stage 1 fallback).
 */
export const ADMIN_USER_IDS = new Set<number>();
