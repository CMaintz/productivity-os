# Setup guide: everything you do yourself

This is the full list of manual steps for productivity-os and the maintz.dev editor.
Each step is tagged by who does it:
- 🤖 **Claude:** a local Claude Code session can do it for you.
- 🧑 **You:** needs a browser, an app's UI, a login or a secret.

## Let your local Claude drive

Open a terminal in your clone of this repo and run `claude`, then type:

```
/pos-setup
```

The command loads the `pos-setup` skill, which works through this file in order. It does every 🤖 step, stops at each 🧑 step with exact instructions, and checks the result before moving on. You can stop anytime; it picks up where you left off, because it ticks steps off in `out/pos-setup-progress.md`.

Rules the local Claude follows:
- It never asks you to paste a secret into the chat. Secrets go straight into `wrangler`/`gh` prompts in your own terminal, or are generated and piped without being shown.
- It never merges, moves folders or changes settings without your yes.
- Everything is run from this repo's folder unless a step says otherwise.

---

## 0. Prerequisites (Windows)
1. 🤖 Check the versions: `node -v` (needs 22+), `git --version`, `gh --version`, `claude --version`.
2. 🧑 Install whatever is missing:
   - [Node 22 LTS](https://nodejs.org)
   - [Git for Windows](https://git-scm.com)
   - GitHub CLI: `winget install GitHub.cli`
   - [Obsidian](https://obsidian.md)
3. 🧑 `gh auth login` (opens the browser), then 🤖 confirm with `gh auth status`.

## 1. Merge the open PRs
1. 🧑 Review and merge **productivity-os #4** (session tracking, docs lists, GitHub sync, `/resume`, `/next`).
2. 🧑 Merge **cmaintz-site #91** (Keystatic editor and cross-posting), **then #92** (the CI job). Either order works, but this one is cleanest.
3. 🤖 Pull the merged code: `git pull` in `C:\Users\akash\Projects\productivity-os`.

## 2. Reorganise Projects (Phase 0)
1. 🤖 `npm run inventory`. This only reads; it writes `out\inventory.md`.
2. 🤖 Say "reorganise my projects". Claude writes `out\reorg-proposal.md` with 2–3 structures, a move table and a loose-docs table.
3. 🧑 Read the proposal and tell Claude what to change. Approve when happy.
4. 🤖 Claude writes `out\reorg-plan.json` and runs the dry run. 🧑 Commit and push anything listed under "unsaved work" (or ask Claude to). Close IDEs that have those folders open.
5. 🧑 Say "go". 🤖 Claude runs `--apply` and gives you the undo command and the post-move checklist: reopen projects in the IDE from their new paths, and rebuild any flagged venvs.

## 3. Vault
1. 🤖 `npm run inventory` then `npm run vault`. This creates or refreshes `C:\Users\akash\Vault`: new project notes, updated paths, docs lists, and `_system\tools.json`.
2. 🤖 `node tools/vault/init.mjs --update-system`. Pulls in the newest `CLAUDE.md`, skills (`/today`, `/capture`, `/shutdown`, `/resume`, `/next`) and Bases. Old copies go to `_system\backup\`.
3. 🤖 With your OK, add these blocks to `Vault\Home.md`. They're missing from vaults created before them; `Home.md` is yours, so it's never overwritten.
   ```markdown
   ## Needs attention
   ![[Projects.base#Needs attention]]

   ## Claude sessions
   ![[Sessions.base#Active]]
   ```
4. 🧑 **Obsidian:**
   - Open `C:\Users\akash\Vault` as a vault.
   - Settings → Core plugins: turn on **Bases**, **Daily notes** and **Templates**.
   - Settings → Community plugins: install **Tasks** and **Homepage**, then set Homepage to open `Home.md`.
5. 🤖 `npm run github`. Fills in the `## GitHub` section and CI/PR fields of every project note that has a `repo`. Needs step 0.3.
6. 🧑 Set each project's `status` (active, paused, idea…) and `priority` in the Projects base. The inventory guessed status from commit dates. 🤖 Claude can do a first pass if you tell it which projects matter.

## 4. Claude Code session tracking
1. 🤖 `npm run hooks`. Adds the session hook to `%USERPROFILE%\.claude\settings.json`, after making a backup.
2. 🧑 Restart any open Claude Code sessions. 🤖 Check that a new session creates a note in `Vault\Sessions\`.
3. 🧑 In a Claude Code session inside the vault (`cd $env:USERPROFILE\Vault; claude`): `/plugin marketplace add kepano/obsidian-skills`, then install the skills it lists. This command is interactive, so it has to be you.

## 4b. Action cards and the executor
1. 🧑 Obsidian → Community plugins: install **Meta Bind**. Card buttons depend on it.
2. 🤖 `npm run vault` then `node tools/vault/init.mjs --update-system`. This picks up the card views, the `/suggest` skill and the updated contract, and records this PC as `mainHost` in `_system\tools.json`.
3. 🤖 With your OK, add this to `Vault\Home.md` under "Waiting on me":
   ```markdown
   ## Ran on their own
   ![[Actions.base#Ran on their own]]
   ```
4. 🤖 `npm run suggest`, then show the cards it made. 🧑 Press a button on one. 🤖 `npm run executor` and confirm the card updated.
5. 🤖 With your OK: `powershell -ExecutionPolicy Bypass -File tools\actions\install-executor.ps1`, which starts the executor hidden at logon. Check it with `Get-ScheduledTask -TaskName 'productivity-os executor' | Get-ScheduledTaskInfo`.

## 5. Phone (Android) sync
1. 🧑 Install **Syncthing** on the PC and **Syncthing-Fork** on Android.
2. 🧑 Share `C:\Users\akash\Vault` to the phone. The vault's `.stignore` already keeps out `.git` and the private prompt log.
3. 🧑 On the phone, open the synced folder as a vault in Obsidian.

## 6. maintz.dev blog editor (after #91 is merged)
1. 🧑 **Create the GitHub App:** github.com → Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - **Name:** something like `maintz-dev-editor`. The URL slug it gets is your app slug.
   - **Homepage URL:** `https://maintz.dev`.
   - **Callback URL:** `https://maintz.dev/api/keystatic/github/oauth/callback`.
   - ✅ **Expire user authorization tokens.** ✅ **Request user authorization (OAuth) during installation.**
   - **Webhook:** untick **Active**.
   - **Repository permissions:**
     - Contents: Read and write
     - Pull requests: Read and write
     - Metadata: Read
   - **Where can this app be installed:** Only on this account. Then click **Create**.
   - On the app page: **Generate a new client secret** and keep that tab open. Note the **Client ID**.
   - **Install App** → only `CMaintz/cmaintz-site`.
2. 🧑 `npx wrangler login` in `C:\Users\akash\Projects\…\cmaintz-site` (browser login to Cloudflare).
3. 🧑 In your own terminal, so the values never touch the chat:
   ```powershell
   npx wrangler secret put KEYSTATIC_GITHUB_CLIENT_ID --name cmaintz-site      # paste the Client ID
   npx wrangler secret put KEYSTATIC_GITHUB_CLIENT_SECRET --name cmaintz-site  # paste the client secret
   ```
4. 🤖 Generate and store the session secret without displaying it:
   ```powershell
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put KEYSTATIC_SECRET --name cmaintz-site
   ```
5. 🤖 `gh variable set PUBLIC_KEYSTATIC_GITHUB_APP_SLUG --repo CMaintz/cmaintz-site --body <app-slug>`. 🧑 You tell Claude the slug.
6. 🤖 Redeploy so the build picks up the variable: `gh workflow run ci.yml --repo CMaintz/cmaintz-site --ref main`, then `gh run watch` until it's green.
7. 🧑 **Test it:**
   - Open https://maintz.dev/keystatic, log in with GitHub and create a draft post.
   - It should appear as a `post/<slug>` branch. Delete the test branch afterwards.
8. 🧑 **Optional:** Cloudflare dashboard → Zero Trust → Access → Applications → add a self-hosted app for `maintz.dev/keystatic*` and `maintz.dev/api/keystatic*`, with a policy allowing only `cmaintz@outlook.com`.

## 7. Cross-posting (after #92 is merged)
1. 🧑 dev.to → Settings → Extensions → **Generate API key**.
2. 🧑 In your own terminal: `gh secret set DEVTO_API_KEY --repo CMaintz/cmaintz-site`, then paste the key at the prompt.
3. 🤖 Dry run from the site repo: `npm run crosspost -- --dry-run`. It should list nothing, because no post opts in yet.
4. 🧑 **Real test:** in the editor, tick **dev.to** on a post and merge its PR. Afterwards:
   - The `crosspost` job in Actions should create the article, with a canonical link back to maintz.dev.
   - Ticking **LinkedIn** instead opens an issue with a draft to paste.

## Daily use, once set up
| When | What |
|---|---|
| Morning | In the vault: `/today` |
| Something pops up | `/capture <text>` |
| Starting work | `/next`, or `/resume <project>` |
| Anytime | Answer cards under **Waiting on me** (works on the phone). `/suggest` asks for fresh ideas. |
| End of day | `/shutdown` |
| After moving folders | `npm run inventory` then `npm run vault` |
| Writing | https://maintz.dev/keystatic, then merge the post's PR to publish |
