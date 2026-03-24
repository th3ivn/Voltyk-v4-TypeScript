export interface RegionScheduleImage {
  regionId: string;
  queueLabel: string;
  imageUrl: string;
  updatedAtUnix: number;
  statusText: string;
}

export interface UserSettings {
  userId: number;
  chatId: number;
  regionId: string;
  queueLabel: string;
  isActive: boolean;
}

export interface BroadcastJob {
  dedupKey: string;
  user: UserSettings;
  payload: RegionScheduleImage;
  attempts: number;
}

export interface ScheduleSnapshot {
  updatedAtUnix: number;
  regions: RegionScheduleImage[];
}
