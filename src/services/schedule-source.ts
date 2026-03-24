import type { RegionScheduleImage, ScheduleSnapshot } from '../types/domain.js';

interface SourcePayload {
  updatedAtUnix: number;
  regions: Array<{
    regionId: string;
    queueLabel: string;
    imageUrl: string;
    statusText: string;
  }>;
}

export class ScheduleSource {
  constructor(private readonly sourceJsonUrl: string) {}

  async fetchSnapshot(): Promise<ScheduleSnapshot> {
    const response = await fetch(this.sourceJsonUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch schedule source: ${response.status}`);
    }

    const json = (await response.json()) as Partial<SourcePayload>;
    const updatedAtUnix = Number(json.updatedAtUnix);
    const regionsPayload = Array.isArray(json.regions) ? json.regions : [];

    if (!Number.isFinite(updatedAtUnix) || updatedAtUnix <= 0) {
      throw new Error('Schedule source has invalid updatedAtUnix');
    }

    const regions: RegionScheduleImage[] = [];

    for (const region of regionsPayload) {
      if (!region || typeof region !== 'object') {
        continue;
      }

      const regionId = region.regionId;
      const queueLabel = region.queueLabel;
      const imageUrl = region.imageUrl;
      const statusText = region.statusText;

      if (
        typeof regionId !== 'string' ||
        typeof queueLabel !== 'string' ||
        typeof imageUrl !== 'string' ||
        typeof statusText !== 'string'
      ) {
        continue;
      }

      regions.push({
        regionId,
        queueLabel,
        imageUrl,
        statusText,
        updatedAtUnix,
      });
    }

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
}
