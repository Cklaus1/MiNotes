/** Open Settings at a section: callers set the target, then open Settings; the
 *  panel takes it once (the same pattern as `targetSyncSettings`). */
let wanted: string | null = null;

export function targetSettingsSection(title: string): void {
  wanted = title;
}

export function takeSettingsSection(): string | null {
  const w = wanted;
  wanted = null;
  return w;
}
