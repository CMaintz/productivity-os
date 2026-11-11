// The structural-smell rules for plain JavaScript, run only by habit-hooks (via
// `[sensors.eslint] args` in .habit-hooks/config.toml). The thresholds are the ones the
// habit-hooks typescript plugin ships, so JS and TS are held to the same bar; that
// config can't be reused directly because it hard-requires typescript-eslint.
// oversized-file is left to the generic line-count sensor, which owns the 300-line limit.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// `--config` replaces the project's eslint config for this run, so it is spread in first:
// its own rules (a security ban, say) keep reporting through habit-hooks. Looked up from
// cwd, which is eslint's base path under `--config` and where habit-hooks runs. Only the
// root config: `--config` also turns off eslint's per-directory lookup, so a nested
// package's own config is not seen here.
async function projectConfig() {
  const names = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];
  const own = names.map((name) => path.resolve(name)).find((file) => fs.existsSync(file));
  return own ? (await import(pathToFileURL(own).href)).default : [];
}

export default [
  // flat(): a config may export one object rather than an array.
  ...[await projectConfig()].flat(),
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    rules: {
      "max-lines-per-function": ["error", { max: 12, skipBlankLines: false, skipComments: false, IIFEs: true }],
      "max-params": ["error", 3],
      complexity: ["error", 10],
      "max-depth": ["error", { max: 4 }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-duplicate-imports": "error",
      "no-warning-comments": ["warn", { terms: ["todo", "fixme", "xxx", "hack"], location: "anywhere" }],
    },
  },
];
