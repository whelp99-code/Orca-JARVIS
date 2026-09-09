/** Frozen scoped profile digests; unknown profiles are rejected by the caller. */
export function secondBrainScopedContractDigest(profile: string): string {
  return profile === "scoped-request-status-v1" ? "973c4ed1d26a7b258e6b35c261c074666bebd54c5de354d89fb0b085414294cf" :
    profile === "scoped-request-write-v1" ? "023cdf5bebc8b96356645a8927dda80b71e8974ce7f4f5300735e63f904aecde" :
    profile === "scoped-record-read-v5" ? "4aaadbd6c5670c6f69e811567e2a93abcd746112d86697cfd391ef49aa4853c3" :
    profile === "scoped-record-read-v4" ? "707ea8dcbdc2aebe0aaa5c90743ebb247adde9d469dd51a0564c2cb8728d53e2" :
    profile === "scoped-record-read-v3" ? "c3d4b1d883d8966fcc39b5f26e999159cb60977c248683d5719da27fd5500ad8" :
    profile === "scoped-record-read-v2" ? "a5af30045ba19eb6e79d07f649e3049842741822d75bdb7212d2ec7eabd9cb37" :
    "2c0bc8a467cb3f89f7c8cdb7df0a4eceb9790250b05d3fecffc13fb485417a7b";
}
