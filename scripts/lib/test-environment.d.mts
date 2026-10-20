export function createTestEnvironment(env?: NodeJS.ProcessEnv): {
  root: string; env: NodeJS.ProcessEnv; cleanup(): void;
};
export function providerStorageBase(env?: NodeJS.ProcessEnv): string;
