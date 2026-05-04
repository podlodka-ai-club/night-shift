import type { ProjectExtensionManifest } from './shared';

export function createEmptyProjectExtensionManifest(): ProjectExtensionManifest {
  return {
    prompts: {
      specify: { prepend: [], append: [] },
      implement: { prepend: [], append: [] },
      review: { prepend: [], append: [] },
    },
    agentDefaults: {},
    agents: {},
    qualityGates: [],
  };
}