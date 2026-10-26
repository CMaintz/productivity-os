#!/usr/bin/env node
// Adds the productivity-os MCP server to Claude Desktop's config, keeping everything else in it.
// Claude Desktop starts servers with the system PATH, where mise's Node isn't, so the entry
// points at the absolute Node binary running this script.
//
// Usage: node tools/mcp/install.mjs [--vault <dir>] [--config <path>]   (npm run mcp:install)
// A timestamped backup of the config is written first. Restart Claude Desktop afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultFromArgs } from '../lib/cli.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const NAME = 'productivity-os';

/** The config with our server entry set; other servers and settings are left as they were. */
export const withServer = (config, { command, server, vault }) => ({
  ...config, mcpServers: { ...config.mcpServers, [NAME]: { command, args: [server, '--vault', vault] } },
});

function defaultConfig() {
  const file = 'claude_desktop_config.json';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', file);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', file);
  return path.join(os.homedir(), '.config', 'Claude', file);
}

function main() {
  const i = process.argv.indexOf('--config');
  const file = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaultConfig();
  const vault = path.resolve(vaultFromArgs());
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, JSON.stringify(withServer(current, { command: process.execPath, server: SERVER, vault }), null, 2) + '\n');
  console.log(`Added the ${NAME} MCP server (vault ${vault}) to ${file}. Restart Claude Desktop to load it.`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'install.mjs') main();
