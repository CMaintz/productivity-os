import path from 'node:path';
import os from 'node:os';

/** The vault a CLI acts on: --vault <dir>, else $PRODUCTIVITY_VAULT, else ~/Vault. */
export function vaultFromArgs(argv = process.argv) {
  const i = argv.indexOf('--vault');
  return i > 0 && argv[i + 1] ? argv[i + 1] : process.env.PRODUCTIVITY_VAULT || path.join(os.homedir(), 'Vault');
}
