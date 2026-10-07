# OmniTerminal

A Windows desktop **Multi-Terminal Manager**: unlimited, independent, persistent terminal sessions,
each with its own environment and CLI identity (Claude Code, gcloud, GitHub CLI, Git, …).

**One terminal = one independent environment.** Terminals are real ConPTY terminals with full access to your machine.
They are not sandboxes or containers.

## Install / run

| What | Where |
|---|---|
| Installer (per-user, no admin) | `release\OmniTerminal-Setup-1.0.0.exe` |
| Portable (unzip and run `OmniTerminal.exe`) | `release\OmniTerminal-1.0.0-win-x64.zip` |
| Unpacked build | `release\win-unpacked\OmniTerminal.exe` |

From source (Node 22+):

```powershell
npm install
npm run dev        # dev mode (uses %LOCALAPPDATA%\OmniTerminal-dev, never your real profiles)
npm start          # production build + run
npm test           # unit + integration tests (real ConPTY, real DPAPI, real named pipe)
npm run test:e2e   # drives the real Electron GUI with Playwright
npm run dist       # installer + portable zip in .\release
```

## Using it

* **+ New Terminal** (or `Ctrl+Shift+T`): name, working directory, shell (detected: Windows PowerShell, PowerShell 7,
  CMD, Git Bash, each WSL distro, or a custom exe), optional startup command, optional environment variables.
  *Create & Launch* creates the private profile folder, starts the session and opens it in a tab.
* **Sidebar**: click a terminal to open it, or to start it if it is stopped. Right-click for Restart / Stop / Rename / Duplicate / Settings / Export / Delete.
* **All Terminals** dashboard: search, sort, *Running* and *Stopped* shown in separate groups, one-click Open/Reconnect.
* **Tabs**: closing a tab only detaches it. The session keeps running and shows as *Disconnected* until you reconnect.
* Status: **Running** = alive and shown here · **Disconnected** = alive in the session manager, not shown · **Stopped** = no process.
* **Activity dots**: a blue dot on a background tab or sidebar entry means new output; a pulsing amber dot means the program
  rang the bell and wants attention. Claude Code can ring the bell when it finishes (enable its terminal-bell notifications).
  When the window isn't focused, the taskbar button flashes and a Windows notification appears; click it to jump to that terminal.
* The top bar shows the title set by the running program (e.g. `claude`, `vim notes.txt`).
* Drag terminals in the sidebar to reorder them. The dashboard has **Stop all**.
* Keys:

| Keys | Action |
|---|---|
| `Ctrl+C` | Copy if text is selected, otherwise SIGINT |
| `Ctrl+V`, `Ctrl+Shift+V`, right-click | Paste (right-click copies when text is selected) |
| `Ctrl+Shift+C` | Copy |
| `Ctrl+Shift+F` | Find in terminal (Enter / Shift+Enter, case and regex toggles) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset (per tab) |
| `Ctrl+Shift+T` | New terminal |
| `Ctrl+Shift+W` | Close tab (the session keeps running) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+Shift+A` | All Terminals dashboard |
| `Ctrl+click` | Open link |

## Architecture

```
OmniTerminal.exe (GUI, Electron + React + xterm.js)
        │  named pipe \\.\pipe\omniterminal-<user>-<hash>, token-authenticated JSON-RPC
        ▼
OmniTerminal.exe in Node mode = Session Manager (src/daemon)
        ├── PTY (ConPTY via node-pty) + headless xterm mirror ── Terminal 01
        ├── PTY + mirror ───────────────────────────────────── Terminal 02
        └── …  (no artificial limit)
        SQLite (sql.js) · profile folders · DPAPI secrets
```

* The **session manager** owns every PTY. The GUI never owns terminal processes. It is launched without handle
  inheritance and outside the GUI's job object, so it outlives the GUI.
* Each session keeps a **headless xterm mirror**. On reconnect the GUI receives an exact serialized snapshot of the
  screen and scrollback, then the live stream. Nothing is lost or duplicated, and alternate-screen apps such as vim or `claude` come back intact.
* Closing the window disconnects the GUI and leaves sessions running. If a terminal has *Keep running when window closes*
  turned off, it is stopped on a normal close, but never on a GUI crash.
* **Exit completely** (Settings) stops every session and the session manager.
* With no window and no running terminals, the manager exits after 10 minutes, unless *Keep running* or
  *Start with Windows* is enabled. *Start with Windows* registers `OmniTerminal.exe --daemon-only` (HKCU Run).
* **Crash recovery**: the GUI reconnects or respawns the manager automatically. When the manager restarts after a crash,
  it finds session records left by the dead instance. Leftover processes are killed only if their PID **and creation time**
  match, so recycled PIDs are never touched. The DB is written atomically with a rolling `.bak`, and every profile also has a
  `metadata.json` mirror that rebuilds the registry if the DB is lost.

Source layout:

| Area | Path |
|---|---|
| UI (React) | `src/renderer/` (`App.tsx`, `components/`) |
| Terminal renderer | `src/renderer/terminal/terminalHost.ts` (xterm.js + WebGL/fit/links/unicode11) |
| PTY manager | `src/daemon/pty/` (`ptySession.ts`, `shells.ts`) |
| Session manager | `src/daemon/sessions/sessionManager.ts`, `src/daemon/server.ts`, `src/daemon/main.ts` |
| Profile manager | `src/daemon/profiles/profileManager.ts` |
| Credential manager | `src/daemon/credentials/` (DPAPI secret store) |
| Environment manager | `src/daemon/env/environmentManager.ts`, tool registry `src/shared/tools.ts` |
| Persistence | `src/daemon/persistence/db.ts` (SQLite: profiles, settings, session registry, UI prefs) |
| Security | `src/shared/validation.ts` (names, slugs, path traversal), `src/shared/redact.ts` |
| Windows integration | `src/daemon/windows/`, `src/main/windowsIntegration.ts` (autostart) |
| Client / IPC | `src/client/daemonClient.ts`, `src/main/` |

## Data layout

```
%LOCALAPPDATA%\OmniTerminal\
  omniterminal.db(.bak)        SQLite: metadata, settings, session registry, UI prefs (no secrets)
  run\daemon.json              manager pid + pipe + per-run auth token (user-private folder)
  logs\session-manager.log     redacted manager log
  profiles\<slug>\
    config\claude  gcloud  github  git\.gitconfig  azure  aws  kube  npm  codex …
    credentials\secrets.dpapi.json   secret env vars, DPAPI (CurrentUser) + per-profile entropy
    history\                   powershell_history.txt, bash_history, node/python REPL history
    logs\session.log           lifecycle log (optional redacted transcripts)
    cache\  environment\  metadata.json
```

Renaming a terminal keeps its folder. Folder names are sanitized slugs (`[a-z0-9-]`, Windows device names avoided),
and every path is checked to stay inside `profiles\`.

## Isolation

Each terminal gets its own process environment with these redirections. Toggle them per terminal under
*Settings → Tools*, and add **custom mappings** (`ENV_VAR → path inside the profile`) for any other CLI.

| Tool | Variable(s) | Isolation |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | **Full**: settings, `.claude.json`, history and OAuth `.credentials.json` |
| Google Cloud SDK | `CLOUDSDK_CONFIG` | **Full**: accounts, `credentials.db`, ADC |
| Git + Git Credential Manager | `GIT_CONFIG_GLOBAL`, `GCM_NAMESPACE` | **Full** for global config and GCM HTTPS credentials (namespaced per terminal in Credential Manager) |
| Azure CLI | `AZURE_CONFIG_DIR` | **Full** |
| kubectl | `KUBECONFIG` | **Full** |
| npm | `NPM_CONFIG_USERCONFIG` | **Full** (`npm login` tokens) |
| OpenAI Codex CLI | `CODEX_HOME` | **Full** |
| Hugging Face (off by default) | `HF_HOME` | **Full** |
| GitHub CLI | `GH_CONFIG_DIR` (+ optional `GH_TOKEN` field) | **Partial** unless a token is set: by default `gh` keeps tokens in Windows Credential Manager, shared by all terminals. Use the token field or `gh auth login --insecure-storage` |
| Supabase CLI | per-terminal `SUPABASE_ACCESS_TOKEN` (token field in *Tools*) | **Isolated when a token is set**. Otherwise `supabase login` is shared |
| Netlify / Fly.io / Cloudflare Wrangler | `NETLIFY_AUTH_TOKEN` / `FLY_API_TOKEN` / `CLOUDFLARE_API_TOKEN` (token fields) | **Isolated when a token is set**. Otherwise their logins are shared |
| AWS CLI | `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` | **Partial**: SSO/CLI token caches in `%USERPROFILE%\.aws\sso\cache` cannot be redirected |
| Docker (off by default) | `DOCKER_CONFIG` | **Partial**: shared if a `credsStore` (desktop/wincred) is configured |
| PowerShell history | PSReadLine `HistorySavePath` (set at launch) | **Full** |
| Bash / Node / Python history | `HISTFILE`, `NODE_REPL_HISTORY`, `PYTHON_HISTORY` | **Full** (`HISTFILE` is forwarded into WSL) |

**Known limitations** (also shown in the app):

* **SSH**: OpenSSH always uses `%USERPROFILE%\.ssh` and the system ssh-agent, so keys are shared. Workaround: `GIT_SSH_COMMAND` with `-i`/`-F` as a variable.
* **WSL**: Linux tools inside a distro use the distro's `$HOME`. Only `HISTFILE` and your own variables are forwarded.
* **CMD** has no persistent history.
* Any tool that writes to Windows Credential Manager without a configurable namespace shares those credentials.
* `HOME`/`USERPROFILE` are deliberately not changed, so tools without a config-dir override share their defaults.

Secrets: variables marked **secret** are encrypted with Windows DPAPI in the terminal's `credentials` folder. They are
decrypted only when a session starts. They are never returned to the GUI, never stored in SQLite, never exported, and are
redacted from logs and transcripts, along with common token formats.

**Duplicate** copies configuration only. Tool login folders, history, secret values and git config are **not** copied,
and the copy gets a new GCM namespace. **Export** writes configuration only, with secret names but no values. Imported
secret values are ignored.

## Tests

`npm test` runs 66 tests:

* profiles: create, rename, delete, duplicate, invalid names, path traversal
* environment and config-dir isolation across 5 simultaneous real ConPTY sessions
* reconnect snapshots
* GUI-crash vs graceful close
* exit codes and restart
* real DPAPI encryption and per-profile entropy
* PSReadLine history isolation
* a real detached session manager over the named pipe: token rejection, GUI close → reconnect, hard-kill crash recovery and orphan cleanup

`npm run test:e2e` drives the real GUI. It creates a terminal, types into xterm.js, closes the app, verifies the session
survived, reopens, and verifies it auto-reconnected with the screen restored. It also checks the Supabase token field, the
attention dot for a background bell, find, and zoom.

Token fields in *Settings → Tools* are stored as encrypted secret variables (same DPAPI storage as other secrets) and apply
after the terminal restarts.
