export const OPERATOR_CODE_ENV = 'SIMULATOR_MCP_OPERATOR_PAIRING_CODE';

// Read the operator pairing code once and remove it from the environment so child processes cannot inherit it.
export function takeOperatorCode(env = process.env) {
  const code = env[OPERATOR_CODE_ENV];
  delete env[OPERATOR_CODE_ENV];
  return code;
}

export function readLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!['--mode', '--namespace'].includes(flag) || !value || options.has(flag)) {
      throw new Error('Use --mode web|desktop|desktop-dev and optionally --namespace for a desktop test profile.');
    }
    options.set(flag, value);
  }
  const mode = options.get('--mode') ?? 'web';
  if (!['web', 'desktop', 'desktop-dev'].includes(mode)) {
    throw new Error('Unknown MCP mode. Use web, desktop, or desktop-dev.');
  }
  const namespace = options.get('--namespace') ?? (mode === 'web' ? undefined : env.SIMULATOR_MCP_NAMESPACE);
  if (namespace !== undefined && (mode === 'web' || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(namespace))) {
    throw new Error('Invalid MCP desktop namespace. Use 1–24 lowercase letters, digits, or hyphens.');
  }
  return { mode, namespace };
}
