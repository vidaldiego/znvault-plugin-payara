// Path: src/cli/config-arg.ts
// Purely lexical detection of whether a `deploy run <arg>` positional is a
// config FILE PATH vs a saved config NAME. Deliberately does NOT probe the
// filesystem — a stray cwd file must never hijack `deploy run <savedName>`.
// A saved config name (from `config create <name>`) never contains a path
// separator or ends in `.json`, so this never misclassifies a real name.

export function isConfigFilePath(arg: string): boolean {
  return arg.includes('/') || arg.includes('\\') || arg.endsWith('.json');
}
