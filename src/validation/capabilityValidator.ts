import type { Capability } from "../contracts/constants/capabilities.js";
import type { IntegrationPluginManifest } from "../contracts/plugins/integrationPluginManifest.js";
import type { ProcessorPluginManifest } from "../contracts/plugins/processorPluginManifest.js";

export interface CapabilityValidationResult {
  valid: boolean;
  missingCapabilities: Capability[];
}

export function validateCapabilities(
  integrationManifests: ReadonlyArray<IntegrationPluginManifest>,
  processorManifests: ReadonlyArray<ProcessorPluginManifest>,
): CapabilityValidationResult {
  const providedCapabilities = new Set<Capability>(
    processorManifests.flatMap(
      (manifest) => manifest.providesCapabilities ?? [],
    ),
  );

  const missingCapabilities = [
    ...new Set(
      integrationManifests.flatMap((manifest) =>
        (manifest.requiresCapabilities ?? []).filter(
          (capability) => !providedCapabilities.has(capability),
        ),
      ),
    ),
  ];

  return {
    valid: missingCapabilities.length === 0,
    missingCapabilities,
  };
}
