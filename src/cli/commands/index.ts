// Path: src/cli/commands/index.ts
// CLI commands module entry point

export { registerConfigCommands } from './deploy-config.js';
export { registerLifecycleCommands } from './lifecycle.js';
export { registerDeployRunCommand } from './deploy-run.js';
export { registerDeployWarCommand } from './deploy-war.js';
export { deployToHost, uploadFullWar, deployChunked } from './deploy.js';
export type { DeployOperationResult } from './deploy.js';
export {
  exitWithError,
  getConfigOrExit,
  withErrorHandling,
  loadInquirer,
  confirmPrompt,
  saveConfigsOrExit,
} from './helpers.js';
