import fs from 'node:fs';
import path from 'node:path';

/** _system/tools.json: where productivity-os lives, which PC is main, which GitHub repo it is. */
export function readToolsConfig(vault) {
  const file = path.join(vault, '_system', 'tools.json');
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}
