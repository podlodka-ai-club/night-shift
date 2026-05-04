import type { ProjectExtensionPromptContributions } from '../shared';

export function renderProjectExtensionGuidance(contributions: ProjectExtensionPromptContributions | undefined): string[] {
  // Project extensions are repo-authored code, so these strings are trusted inputs rather than
  // external/user content that needs <untrusted-input> hardening markers.
  // This dedicated section preserves author intent by rendering prepend entries before append entries.
  const guidance = [...(contributions?.prepend ?? []), ...(contributions?.append ?? [])];
  return guidance.length === 0
    ? []
    : ['## Project extension guidance', ...guidance.flatMap((text, index) => (index === 0 ? [text] : ['', text]))];
}