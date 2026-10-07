import type { ToolDefinition } from './types';

/**
 * Registry of CLI tools whose configuration/credential location can be redirected per terminal.
 * Add new tools here: each mapping becomes an environment variable pointing into the profile dir.
 *
 * isolation:
 *   full    – config AND credentials live under the redirected location.
 *   partial – config is isolated but some credential/cache path is OS-global (see notes).
 *   shared  – cannot be isolated by the app (listed in LIMITATIONS only).
 */
export const TOOL_REGISTRY: ToolDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    category: 'cli',
    mappings: [{ envVar: 'CLAUDE_CONFIG_DIR', path: 'config/claude', kind: 'dir' }],
    isolation: 'full',
    notes: 'Settings, .claude.json, session history and OAuth credentials (.credentials.json on Windows) are stored in CLAUDE_CONFIG_DIR.',
    defaultEnabled: true,
  },
  {
    id: 'gcloud',
    name: 'Google Cloud SDK (gcloud)',
    category: 'cli',
    mappings: [{ envVar: 'CLOUDSDK_CONFIG', path: 'config/gcloud', kind: 'dir' }],
    isolation: 'full',
    notes: 'Accounts, credentials.db, access tokens and application-default credentials live in CLOUDSDK_CONFIG.',
    defaultEnabled: true,
  },
  {
    id: 'gh',
    name: 'GitHub CLI (gh)',
    category: 'cli',
    mappings: [{ envVar: 'GH_CONFIG_DIR', path: 'config/github', kind: 'dir' }],
    isolation: 'partial',
    notes:
      'Config and hosts.yml are isolated, but by default gh stores OAuth tokens in Windows Credential Manager (service "gh:github.com"), which is shared by all terminals. ' +
      'For full isolation log in with "gh auth login --insecure-storage" (token kept in this terminal\'s hosts.yml) or set a GH_TOKEN below.',
    defaultEnabled: true,
    tokenVars: [{ envVar: 'GH_TOKEN', label: 'GitHub token', help: 'github.com → Settings → Developer settings → Personal access tokens' }],
    whoami: 'gh auth status',
  },
  {
    id: 'git',
    name: 'Git (+ Git Credential Manager)',
    category: 'cli',
    mappings: [
      { envVar: 'GIT_CONFIG_GLOBAL', path: 'config/git/.gitconfig', kind: 'file' },
      { envVar: 'GCM_NAMESPACE', path: '', kind: 'value', value: 'omniterminal-{slug}' },
    ],
    isolation: 'full',
    notes:
      'Global git config (user.name, user.email, aliases) is per terminal. Git Credential Manager entries in Windows Credential Manager are namespaced per terminal via GCM_NAMESPACE, ' +
      'so HTTPS logins do not collide. The system gitconfig (Program Files) still applies. SSH keys are NOT isolated (see Limitations).',
    defaultEnabled: true,
  },
  {
    id: 'azure',
    name: 'Azure CLI (az)',
    category: 'cli',
    mappings: [{ envVar: 'AZURE_CONFIG_DIR', path: 'config/azure', kind: 'dir' }],
    isolation: 'full',
    notes: 'Profiles and the MSAL token cache (DPAPI-encrypted on Windows) live in AZURE_CONFIG_DIR.',
    defaultEnabled: true,
  },
  {
    id: 'aws',
    name: 'AWS CLI',
    category: 'cli',
    mappings: [
      { envVar: 'AWS_CONFIG_FILE', path: 'config/aws/config', kind: 'file' },
      { envVar: 'AWS_SHARED_CREDENTIALS_FILE', path: 'config/aws/credentials', kind: 'file' },
    ],
    isolation: 'partial',
    notes: 'Config and static credentials are isolated. The AWS SSO / CLI token caches (%USERPROFILE%\\.aws\\sso\\cache and \\cli\\cache) are not configurable and remain shared.',
    defaultEnabled: true,
  },
  {
    id: 'kube',
    name: 'kubectl',
    category: 'cli',
    mappings: [{ envVar: 'KUBECONFIG', path: 'config/kube/config', kind: 'file' }],
    isolation: 'full',
    notes: 'Clusters, contexts and embedded credentials live in KUBECONFIG. Exec auth plugins may keep their own caches.',
    defaultEnabled: true,
  },
  {
    id: 'docker',
    name: 'Docker CLI',
    category: 'cli',
    mappings: [{ envVar: 'DOCKER_CONFIG', path: 'config/docker', kind: 'dir' }],
    isolation: 'partial',
    notes:
      'config.json is isolated. If a credsStore ("desktop" / "wincred") is configured, registry logins go to Windows Credential Manager and are shared. Without a credsStore, credentials stay in this terminal\'s config.json.',
    defaultEnabled: false,
  },
  {
    id: 'npm',
    name: 'npm user config (.npmrc)',
    category: 'cli',
    mappings: [{ envVar: 'NPM_CONFIG_USERCONFIG', path: 'config/npm/.npmrc', kind: 'file' }],
    isolation: 'full',
    notes: 'Registry auth tokens written by "npm login" go to this terminal\'s .npmrc. The package cache stays shared (no credentials).',
    defaultEnabled: true,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face CLI',
    category: 'cli',
    mappings: [{ envVar: 'HF_HOME', path: 'config/huggingface', kind: 'dir' }],
    isolation: 'full',
    notes: 'Token and cache live in HF_HOME. Note: models are re-downloaded per terminal.',
    defaultEnabled: false,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'cli',
    mappings: [{ envVar: 'CODEX_HOME', path: 'config/codex', kind: 'dir' }],
    isolation: 'full',
    notes: 'auth.json, config and sessions live in CODEX_HOME.',
    defaultEnabled: true,
  },
  {
    id: 'supabase',
    name: 'Supabase CLI',
    category: 'cli',
    mappings: [],
    isolation: 'partial',
    notes:
      '"supabase login" saves its token in Windows Credential Manager (or %USERPROFILE%\\.supabase), which is shared by all terminals. ' +
      'For a separate Supabase account per terminal, set the access token below: the CLI uses SUPABASE_ACCESS_TOKEN instead of the saved login. ' +
      'Project links (supabase/config.toml, "supabase link") live in each project folder.',
    defaultEnabled: true,
    tokenVars: [{ envVar: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase access token', help: 'supabase.com/dashboard → Account → Access Tokens' }],
    whoami: 'supabase projects list',
  },
  {
    id: 'netlify',
    name: 'Netlify CLI',
    category: 'cli',
    mappings: [],
    isolation: 'partial',
    notes: '"netlify login" uses a shared global config. Set the token below to use a different Netlify account in this terminal.',
    defaultEnabled: true,
    tokenVars: [{ envVar: 'NETLIFY_AUTH_TOKEN', label: 'Netlify token', help: 'app.netlify.com → User settings → Applications → Personal access tokens' }],
    whoami: 'netlify status',
  },
  {
    id: 'fly',
    name: 'Fly.io (flyctl)',
    category: 'cli',
    mappings: [],
    isolation: 'partial',
    notes: '"fly auth login" writes to %USERPROFILE%\\.fly, shared by all terminals. Set the token below for a per-terminal Fly account.',
    defaultEnabled: true,
    tokenVars: [{ envVar: 'FLY_API_TOKEN', label: 'Fly.io token', help: 'fly tokens create org  (or fly.io dashboard → Tokens)' }],
    whoami: 'fly auth whoami',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Wrangler',
    category: 'cli',
    mappings: [],
    isolation: 'partial',
    notes: '"wrangler login" stores OAuth credentials in your user profile, shared by all terminals. Set an API token below for a per-terminal Cloudflare account.',
    defaultEnabled: true,
    tokenVars: [{ envVar: 'CLOUDFLARE_API_TOKEN', label: 'Cloudflare API token', help: 'dash.cloudflare.com → My Profile → API Tokens' }],
    whoami: 'wrangler whoami',
  },
  {
    id: 'bash-history',
    name: 'Bash history (Git Bash / WSL)',
    category: 'history',
    mappings: [{ envVar: 'HISTFILE', path: 'history/bash_history', kind: 'file' }],
    isolation: 'full',
    notes: 'Per-terminal bash history. Forwarded into WSL via WSLENV. Ignored if your ~/.bashrc overrides HISTFILE.',
    defaultEnabled: true,
  },
  {
    id: 'node-history',
    name: 'Node.js REPL history',
    category: 'history',
    mappings: [{ envVar: 'NODE_REPL_HISTORY', path: 'history/node_repl_history', kind: 'file' }],
    isolation: 'full',
    notes: 'Per-terminal history for the interactive "node" REPL.',
    defaultEnabled: true,
  },
  {
    id: 'python-history',
    name: 'Python REPL history',
    category: 'history',
    mappings: [{ envVar: 'PYTHON_HISTORY', path: 'history/python_history', kind: 'file' }],
    isolation: 'full',
    notes: 'Honoured by Python 3.13+.',
    defaultEnabled: true,
  },
];

/** Things the app cannot isolate. Shown in the UI so isolation is never silently overstated. */
export const LIMITATIONS: ToolDefinition[] = [
  {
    id: 'ssh',
    name: 'OpenSSH (ssh, scp, git over SSH)',
    category: 'cli',
    mappings: [],
    isolation: 'shared',
    notes:
      'OpenSSH for Windows always reads %USERPROFILE%\\.ssh and the system-wide ssh-agent service. Keys and known_hosts are shared. ' +
      'Workaround: keep per-terminal keys in <profile>\\config\\ssh and add GIT_SSH_COMMAND="ssh -i <key> -F <config>" as a variable.',
    defaultEnabled: false,
  },
  {
    id: 'cmd-history',
    name: 'CMD history',
    category: 'history',
    mappings: [],
    isolation: 'shared',
    notes: 'cmd.exe keeps history only in memory (doskey); nothing is persisted or shared between terminals.',
    defaultEnabled: false,
  },
  {
    id: 'wsl-tools',
    name: 'Linux tools inside WSL',
    category: 'cli',
    mappings: [],
    isolation: 'shared',
    notes:
      'Inside a WSL distro, Linux CLIs use the distro\'s $HOME. Only HISTFILE and your custom variables are forwarded (WSLENV). Use a separate distro or a custom variable such as CLAUDE_CONFIG_DIR=/home/you/.claude-x for isolation.',
    defaultEnabled: false,
  },
  {
    id: 'credential-manager',
    name: 'Apps using Windows Credential Manager directly',
    category: 'cli',
    mappings: [],
    isolation: 'shared',
    notes:
      'Any tool that writes to Windows Credential Manager without a configurable namespace (e.g. gh default keyring, Docker credsStore, some VS Code/MSAL-based tools) shares those credentials across terminals.',
    defaultEnabled: false,
  },
  {
    id: 'user-profile',
    name: 'Tools that only use %USERPROFILE% / %APPDATA%',
    category: 'cli',
    mappings: [],
    isolation: 'shared',
    notes:
      'OmniTerminal does not change HOME/USERPROFILE (that would break many tools). CLIs with no config-dir override still share their default location. Add a Custom mapping for any tool that supports an env var.',
    defaultEnabled: false,
  },
];

export function getTool(id: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.id === id);
}

export function isToolEnabled(tools: Record<string, boolean>, def: ToolDefinition): boolean {
  return tools[def.id] ?? def.defaultEnabled;
}
