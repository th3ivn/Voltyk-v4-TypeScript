import type { UserSettings } from '../types/domain.js';

export class UserStore {
  private readonly users = new Map<number, UserSettings>();

  upsert(user: UserSettings): void {
    this.users.set(user.userId, user);
  }

  get(userId: number): UserSettings | undefined {
    return this.users.get(userId);
  }

  allActive(): UserSettings[] {
    return [...this.users.values()].filter((user) => user.isActive);
  }
}
