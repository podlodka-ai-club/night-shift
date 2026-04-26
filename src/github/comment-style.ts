export type NightShiftCalloutTone = "NOTE" | "TIP" | "IMPORTANT" | "CAUTION";

export interface NightShiftCalloutOptions {
  label: string;
  title: string;
  tone?: NightShiftCalloutTone;
  details?: string[];
}

export function renderNightShiftCallout(options: NightShiftCalloutOptions): string {
  const lines = [
    `> [!${options.tone ?? "NOTE"}]`,
    `> **${options.label}**`,
    `> ${options.title}`,
  ];

  for (const detail of options.details ?? []) {
    if (!detail.trim()) {
      continue;
    }
    lines.push(`> ${detail}`);
  }

  return lines.join("\n");
}

export function prependNightShiftCallout(
  body: string,
  options: NightShiftCalloutOptions,
): string {
  return `${renderNightShiftCallout(options)}\n\n${body}`;
}

export function prependNightShiftBadge(body: string, label: string): string {
  return `**${label}**\n\n${body}`;
}