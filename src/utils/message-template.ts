import type { RegionScheduleImage, UserSettings } from '../types/domain.js';

export function buildScheduleCaption(payload: RegionScheduleImage, user: UserSettings): string {
  return [
    `💡 <b>Графік відключень на сьогодні</b>`,
    `<b>Регіон:</b> ${escapeHtml(user.regionId)} | <b>Черга:</b> ${escapeHtml(user.queueLabel)}`,
    '',
    `${escapeHtml(payload.statusText)}`,
    `🌀 <b>Оновлено:</b> <tg-time unix="${payload.updatedAtUnix}" format="r">щойно</tg-time>`,
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
