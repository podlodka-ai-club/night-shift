export const NIGHT_SHIFT_MARKER_PREFIX = '<!-- night-shift:';

export function buildNightShiftMarker(marker: string): string {
  return `${NIGHT_SHIFT_MARKER_PREFIX}${marker} -->`;
}

export function isNightShiftMarkerComment(body: string): boolean {
  return body.includes(NIGHT_SHIFT_MARKER_PREFIX);
}