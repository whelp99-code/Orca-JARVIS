export const REJECTED_TASK30_MIGRATIONS = [
  {
    id: "040_memory_effect_requests.sql",
    checksum: "619e22969bb3076c513ac7fba13101df79d0e2b0ab70ee8bb5fe0976a53c3ae2",
    tables: ["memory_effect_requests"],
  },
  {
    id: "041_memory_effect_delegations.sql",
    checksum: "c00586bce2b34fc07e777b4ef3a6043bf0a7938ad35e40a0ba449aa186b4e510",
    tables: [
      "memory_effect_delegation_keys",
      "memory_external_erasure_keys",
      "memory_effect_delegations",
      "memory_effect_delegation_revocations",
      "memory_effect_delegation_uses",
    ],
  },
  {
    id: "042_memory_effect_progress.sql",
    checksum: "061a1c6c49bb6c9aa8497b77c56d28c060c30254019faf2c2ccb7b15d91b7454",
    tables: ["memory_effect_progress"],
  },
  {
    id: "043_memory_erasure_ledger.sql",
    checksum: "6d63cda882418313f54cc546995297d74ebef6921145be94b82fb6396c04b707",
    tables: ["memory_provider_proof_keys", "memory_erasure_ledger"],
  },
  {
    id: "044_memory_targets_tombstones.sql",
    checksum: "40e98be8fdcb90ef3c9817fcc2a6d9e10be4571344fd50b43615c7b1795d1851",
    tables: ["memory_resolved_targets", "memory_effect_request_targets", "memory_tombstone_watermarks"],
  },
] as const;
