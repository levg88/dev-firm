/**
 * Application settings: environment loading, persistence helpers, and the
 * {@link Settings} class.
 *
 * @module config
 */
import fs from 'node:fs';
import path from 'node:path';

/** OPENCODE_BASE_URL constant. */
export const OPENCODE_BASE_URL = 'https://opencode.ai/inference/openai/v1';

/** OPENCODE_FREE_MODELS constant. */
export const OPENCODE_FREE_MODELS = [
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'big-pickle',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-lightning-free',
  'beam-free',
  'flint-40b-free',
  'pulse-alpha-free',
];

/** PROVIDERS constant. */
const PROVIDERS = ['openai', 'anthropic', 'ollama', 'opencode', 'mock'] as const;
/** Provider type. */
export type Provider = (typeof PROVIDERS)[number];

/** Type guard for supported LLM providers. */
export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Load a .env file into process.env without overriding existing values. */
export function loadDotenv(file: string): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Parse a boolean environment variable with a fallback. */
function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Parse a float environment variable with a fallback. */
function envFloat(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(value) ? value : fallback;
}

/** Parse an integer environment variable with a fallback. */
function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

/** Pick a provider from explicit env or available API keys. */
function defaultProvider(): Provider {
  const explicit = process.env.DEV_FIRM_PROVIDER;
  if (explicit) {
    const lowered = explicit.trim().toLowerCase();
    if (isProvider(lowered)) return lowered;
    return 'mock';
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENCODE_API_KEY) return 'opencode';
  return 'mock';
}

/** Default model name for a provider. */
export function defaultModelFor(provider: string): string {
  const models: Record<string, string> = {
    openai: 'gpt-4.1',
    anthropic: 'claude-sonnet-4-20250514',
    ollama: 'llama3.1',
    opencode: 'deepseek-v4.1-flash-free',
    mock: 'mock',
  };
  return models[provider] ?? 'gpt-4.1';
}

/** Default base URL for a provider. */
export function defaultBaseUrlFor(provider: string): string {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    ollama: 'http://localhost:11434/v1',
    opencode: OPENCODE_BASE_URL,
  };
  return urls[provider] ?? '';
}

/** Resolve the model for a provider, honoring DEV_FIRM_MODEL. */
function defaultModel(provider: Provider): string {
  return process.env.DEV_FIRM_MODEL || defaultModelFor(provider);
}

/** Trim and strip trailing slashes from a URL. */
function cleanUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** True when `dir` directly contains at least one git checkout. */
function hasGitCheckouts(dir: string): boolean {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, '.git')));
  } catch {
    return false;
  }
}

/**
 * Pick a sensible folder for local repositories. `DEV_FIRM_REPOS_DIR` wins;
 * otherwise look next to the app, in `~/Workspace`, then in `<home>/repos`.
 */
export function defaultReposDir(home: string): string {
  const explicit = process.env.DEV_FIRM_REPOS_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.resolve(process.cwd(), '..'),
    path.resolve(process.env.HOME || home, 'Workspace'),
    path.resolve(home, 'repos'),
  ];
  for (const candidate of candidates) {
    if (hasGitCheckouts(candidate)) return candidate;
  }
  return path.resolve(home, 'repos');
}

/**
 * Application configuration: paths, provider/model selection, GitHub sync, and
 * per-role overrides. Loaded from environment + persisted DB settings.
 */
export class Settings {
  home: string;
  dataDir: string;
  dbPath: string;
  storageDir: string;
  runsDir: string;
  agentsDir: string;
  reposDir: string;
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  ollamaBaseUrl: string;
  opencodeApiKey: string;
  opencodeBaseUrl: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  maxAgentSteps: number;
  maxBuildIterations: number;
  allowHeuristicFallback: boolean;
  host: string;
  port: number;
  setupComplete: boolean;
  ticketPrefix: string;
  githubEnabled: boolean;
  githubOwner: string;
  githubRepo: string;
  githubProjectTitle: string;
  githubProjectNumber: number;
  githubAutoCreateProject: boolean;
  githubDefaultAssignee: string;
  githubAssigneeLogins: Record<string, string>;
  githubToken: string;

  /** Per-role model overrides (e.g. DEV_FIRM_MODEL_ARCHITECT). Falls back to `model`. */
  roleModels: Record<string, string>;

  /** Per-role base URL overrides (e.g. DEV_FIRM_OLLAMA_BASE_URL_ARCHITECT for multiple Ollama instances). */
  roleBaseUrls: Record<string, string>;

  /** Provider used by the chat concierge (defaults to opencode when a key is present). */
  conciergeProvider: string;
  /** Model used by the chat concierge. */
  conciergeModel: string;
  /** Base URL for the concierge provider. */
  conciergeBaseUrl: string;
  /** API key override for the concierge provider (falls back to the matching provider key). */
  conciergeApiKey: string;
  /** Fallback models tried in order when the concierge model is rate-limited. */
  conciergeFallbackModels: string[];

  /** Provider used by the build agents (defaults to the main provider). */
  agentProvider: string;
  /** Model used by the build agents. */
  agentModel: string;
  /** Base URL for the agent provider. */
  agentBaseUrl: string;
  /** API key override for the agent provider. */
  agentApiKey: string;
  /** Fallback models tried in order when an agent model is rate-limited. */
  agentFallbackModels: string[];

  constructor(values: {
    home: string;
    provider: Provider;
    model: string;
    apiKey: string;
    baseUrl: string;
    anthropicApiKey: string;
    anthropicBaseUrl: string;
    ollamaBaseUrl: string;
    opencodeApiKey: string;
    opencodeBaseUrl: string;
    temperature: number;
    maxTokens: number;
    timeout: number;
    maxAgentSteps: number;
    maxBuildIterations: number;
    allowHeuristicFallback: boolean;
    host: string;
    port: number;
    setupComplete: boolean;
    ticketPrefix: string;
    githubEnabled: boolean;
    githubOwner: string;
    githubRepo: string;
    githubProjectTitle: string;
    githubProjectNumber: number;
    githubAutoCreateProject: boolean;
    githubDefaultAssignee: string;
    githubAssigneeLogins: Record<string, string>;
    githubToken: string;
    roleModels?: Record<string, string>;
    roleBaseUrls?: Record<string, string>;
    conciergeProvider?: string;
    conciergeModel?: string;
    conciergeBaseUrl?: string;
    conciergeApiKey?: string;
    conciergeFallbackModels?: string[];
    agentProvider?: string;
    agentModel?: string;
    agentBaseUrl?: string;
    agentApiKey?: string;
    agentFallbackModels?: string[];
  }) {
    this.home = values.home;
    this.dataDir = values.home;
    this.dbPath = path.join(values.home, 'dev.db');
    this.storageDir = path.join(values.home, 'storage');
    this.runsDir = path.join(values.home, 'runs');
    this.agentsDir = path.resolve(
      process.env.DEV_FIRM_AGENTS_DIR || path.join(values.home, 'agents'),
    );
    this.reposDir = defaultReposDir(values.home);
    this.provider = values.provider;
    this.model = values.model;
    this.apiKey = values.apiKey;
    this.baseUrl = values.baseUrl;
    this.anthropicApiKey = values.anthropicApiKey;
    this.anthropicBaseUrl = values.anthropicBaseUrl;
    this.ollamaBaseUrl = values.ollamaBaseUrl;
    this.opencodeApiKey = values.opencodeApiKey;
    this.opencodeBaseUrl = values.opencodeBaseUrl;
    this.temperature = values.temperature;
    this.maxTokens = values.maxTokens;
    this.timeout = values.timeout;
    this.maxAgentSteps = values.maxAgentSteps;
    this.maxBuildIterations = values.maxBuildIterations;
    this.allowHeuristicFallback = values.allowHeuristicFallback;
    this.host = values.host;
    this.port = values.port;
    this.setupComplete = values.setupComplete;
    this.ticketPrefix = values.ticketPrefix;
    this.githubEnabled = values.githubEnabled;
    this.githubOwner = values.githubOwner;
    this.githubRepo = values.githubRepo;
    this.githubProjectTitle = values.githubProjectTitle;
    this.githubProjectNumber = values.githubProjectNumber;
    this.githubAutoCreateProject = values.githubAutoCreateProject;
    this.githubDefaultAssignee = values.githubDefaultAssignee;
    this.githubAssigneeLogins = values.githubAssigneeLogins;
    this.githubToken = values.githubToken;
    this.roleModels = values.roleModels ?? {};
    this.roleBaseUrls = values.roleBaseUrls ?? {};
    this.conciergeProvider = values.conciergeProvider ?? '';
    this.conciergeModel = values.conciergeModel ?? '';
    this.conciergeBaseUrl = values.conciergeBaseUrl ?? '';
    this.conciergeApiKey = values.conciergeApiKey ?? '';
    this.conciergeFallbackModels = values.conciergeFallbackModels ?? [];
    this.agentProvider = values.agentProvider ?? '';
    this.agentModel = values.agentModel ?? '';
    this.agentBaseUrl = values.agentBaseUrl ?? '';
    this.agentApiKey = values.agentApiKey ?? '';
    this.agentFallbackModels = values.agentFallbackModels ?? [];
    // Defaults: prefer opencode hosted when a key is present.
    if (!this.conciergeProvider) {
      this.conciergeProvider = this.opencodeApiKey ? 'opencode' : this.provider;
    }
    if (!this.conciergeModel) {
      this.conciergeModel = this.conciergeProvider === 'opencode'
        ? 'deepseek-v4.1-flash-free'
        : this.model;
    }
    if (!this.conciergeBaseUrl) {
      this.conciergeBaseUrl = this.conciergeProvider === 'opencode'
        ? (this.opencodeBaseUrl || 'https://opencode.ai/inference/openai/v1')
        : (this.conciergeProvider === 'ollama' ? this.ollamaBaseUrl : this.baseUrl);
    }
    if (!this.conciergeApiKey) {
      this.conciergeApiKey = this.conciergeProvider === 'opencode'
        ? this.opencodeApiKey
        : (this.conciergeProvider === 'openai' ? this.apiKey : (this.conciergeProvider === 'anthropic' ? this.anthropicApiKey : ''));
    }
    if (!this.conciergeFallbackModels || this.conciergeFallbackModels.length === 0) {
      if (this.conciergeProvider === 'opencode') {
        this.conciergeFallbackModels = [
          'deepseek-v4.1-flash-free',
          'glm-5.3-flash-free',
          'mimo-v2.6-flash-free',
          'nemotron-3.5-lightning-free',
          'beam-free',
          'flint-40b-free',
          'iceman-free',
          'crouton-alpha-free',
          'inkling-2-small-free',
          'big-pickle',
        ];
      } else {
        this.conciergeFallbackModels = [this.conciergeModel];
      }
    }

    // Agent defaults: prefer opencode hosted (free) when a key is present.
    if (!this.agentProvider) {
      this.agentProvider = this.opencodeApiKey ? 'opencode' : this.provider;
    }
    if (!this.agentModel) this.agentModel = this.model;
    if (!this.agentBaseUrl) {
      this.agentBaseUrl = this.agentProvider === 'opencode'
        ? (this.opencodeBaseUrl || 'https://opencode.ai/inference/openai/v1')
        : (this.agentProvider === 'ollama' ? this.ollamaBaseUrl : this.baseUrl);
    }
    if (!this.agentApiKey) {
      this.agentApiKey = this.agentProvider === 'opencode'
        ? this.opencodeApiKey
        : (this.agentProvider === 'openai' ? this.apiKey : (this.agentProvider === 'anthropic' ? this.anthropicApiKey : ''));
    }
    if (!this.agentFallbackModels || this.agentFallbackModels.length === 0) {
      if (this.agentProvider === 'opencode') {
        this.agentFallbackModels = [
          'deepseek-v4.1-flash-free',
          'glm-5.3-flash-free',
          'mimo-v2.6-flash-free',
          'nemotron-3.5-lightning-free',
          'beam-free',
        ];
      } else {
        this.agentFallbackModels = [this.agentModel];
      }
    }
  }

  static load(): Settings {
    const cwd = process.cwd();
    loadDotenv(path.join(cwd, '.env'));
    const repoRoot = path.resolve(__dirname, '..');
    if (repoRoot !== cwd) {
      loadDotenv(path.join(repoRoot, '.env'));
    }
    const home = path.resolve(process.env.DEV_FIRM_HOME || './data');
    const provider = defaultProvider();
    let baseUrl = cleanUrl(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    if (provider === 'ollama') {
      baseUrl = cleanUrl(process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1');
    } else if (provider === 'opencode') {
      baseUrl = cleanUrl(process.env.OPENCODE_BASE_URL || OPENCODE_BASE_URL);
    }
    const envConfigured = Boolean(
      process.env.DEV_FIRM_PROVIDER ||
        process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENCODE_API_KEY,
    );

    const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.DEV_FIRM_GITHUB_TOKEN || '';
    let githubAssigneeLogins: Record<string, string> = {};
    const rawAssignees = process.env.GITHUB_ASSIGNEES_JSON || process.env.DEV_FIRM_GITHUB_ASSIGNEES_JSON || '';
    if (rawAssignees) {
      try {
        const parsed = JSON.parse(rawAssignees);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          githubAssigneeLogins = Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]),
          );
        }
      } catch {
        githubAssigneeLogins = {};
      }
    }
    const githubEnabledExplicit = process.env.DEV_FIRM_GITHUB_ENABLED;
    const githubEnabled = githubEnabledExplicit === undefined
      ? false
      : envBool('DEV_FIRM_GITHUB_ENABLED', false);

    const settings = new Settings({
      home,
      provider,
      model: defaultModel(provider),
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      anthropicBaseUrl: cleanUrl(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'),
      ollamaBaseUrl: cleanUrl(process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1'),
      opencodeApiKey: process.env.OPENCODE_API_KEY || '',
      opencodeBaseUrl: cleanUrl(process.env.OPENCODE_BASE_URL || OPENCODE_BASE_URL),
      temperature: envFloat('DEV_FIRM_TEMPERATURE', 0.2),
      maxTokens: envInt('DEV_FIRM_MAX_TOKENS', 8192),
      timeout: envFloat('DEV_FIRM_TIMEOUT', 600),
      maxAgentSteps: envInt('DEV_FIRM_MAX_STEPS', 40),
      maxBuildIterations: envInt('DEV_FIRM_MAX_ITERATIONS', 5),
      allowHeuristicFallback: envBool('DEV_FIRM_HEURISTIC_FALLBACK', true),
      host: process.env.DEV_FIRM_HOST || '127.0.0.1',
      port: envInt('DEV_FIRM_PORT', 8766),
      setupComplete: envBool('DEV_FIRM_SETUP_COMPLETE', envConfigured),
      ticketPrefix: (process.env.DEV_FIRM_TICKET_PREFIX || 'CAREER').toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'CAREER',
      githubEnabled,
      githubOwner: process.env.GITHUB_OWNER || process.env.DEV_FIRM_GITHUB_OWNER || 'levg88',
      githubRepo: process.env.GITHUB_REPO || process.env.DEV_FIRM_GITHUB_REPO || 'career-firm',
      githubProjectTitle:
        process.env.GITHUB_PROJECT_TITLE || process.env.DEV_FIRM_GITHUB_PROJECT_TITLE || 'Career Team',
      githubProjectNumber: envInt(
        'DEV_FIRM_GITHUB_PROJECT_NUMBER',
        Number.parseInt(process.env.GITHUB_PROJECT_NUMBER ?? '', 10) || 0,
      ),
      githubAutoCreateProject: envBool('DEV_FIRM_GITHUB_AUTO_CREATE', true),
      githubDefaultAssignee:
        process.env.GITHUB_DEFAULT_ASSIGNEE || process.env.DEV_FIRM_GITHUB_DEFAULT_ASSIGNEE || '',
      githubAssigneeLogins,
      githubToken,
      roleModels: this._parseRoleModels(),
      roleBaseUrls: this._parseRoleBaseUrls(),
      conciergeProvider: process.env.DEV_FIRM_CONCIERGE_PROVIDER || '',
      conciergeModel: process.env.DEV_FIRM_CONCIERGE_MODEL || '',
      conciergeBaseUrl: process.env.DEV_FIRM_CONCIERGE_BASE_URL || '',
      conciergeApiKey: process.env.DEV_FIRM_CONCIERGE_API_KEY || '',
      conciergeFallbackModels: process.env.DEV_FIRM_CONCIERGE_FALLBACK_MODELS
        ? process.env.DEV_FIRM_CONCIERGE_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      agentProvider: process.env.DEV_FIRM_AGENT_PROVIDER || '',
      agentModel: process.env.DEV_FIRM_AGENT_MODEL || '',
      agentBaseUrl: process.env.DEV_FIRM_AGENT_BASE_URL || '',
      agentApiKey: process.env.DEV_FIRM_AGENT_API_KEY || '',
      agentFallbackModels: process.env.DEV_FIRM_AGENT_FALLBACK_MODELS
        ? process.env.DEV_FIRM_AGENT_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
    });
    settings.ensureDirs();
    return settings;
  }

  /**
   * Parse per-role model overrides from env vars like DEV_FIRM_MODEL_ARCHITECT.
   * Role names are uppercased with underscores (e.g. BACKEND_DEVELOPER).
   */
  private static _parseRoleModels(): Record<string, string> {
    const roles = [
      'product_manager',
      'architect',
      'team_lead',
      'backend_developer',
      'frontend_developer',
      'tech_lead',
      'qa',
      'devops',
    ];
    const out: Record<string, string> = {};
    for (const role of roles) {
      const envKey = `DEV_FIRM_MODEL_${role.toUpperCase()}`;
      const value = process.env[envKey]?.trim();
      if (value) out[role] = value;
    }
    return out;
  }

  /**
   * Parse per-role base URL overrides from env vars like DEV_FIRM_OLLAMA_BASE_URL_ARCHITECT.
   * Enables multiple Ollama instances on different ports for different roles.
   */
  private static _parseRoleBaseUrls(): Record<string, string> {
    const roles = [
      'product_manager',
      'architect',
      'team_lead',
      'backend_developer',
      'frontend_developer',
      'tech_lead',
      'qa',
      'devops',
    ];
    const out: Record<string, string> = {};
    for (const role of roles) {
      const envKey = `DEV_FIRM_OLLAMA_BASE_URL_${role.toUpperCase()}`;
      const value = process.env[envKey]?.trim();
      if (value) out[role] = cleanUrl(value);
    }
    return out;
  }

  ensureDirs(): void {
    for (const dir of [this.dataDir, this.storageDir, this.runsDir, this.agentsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    for (const sub of ['cvs', 'jobs', 'generated']) {
      fs.mkdirSync(path.join(this.storageDir, sub), { recursive: true });
    }
  }

  get isMock(): boolean {
    return this.provider === 'mock';
  }

  applyConfig(values: Record<string, string>): void {
    if (!values) return;

    const asFloat = (key: string, current: number): number => {
      const parsed = Number.parseFloat(values[key] ?? '');
      return Number.isFinite(parsed) ? parsed : current;
    };
    const asInt = (key: string, current: number): number => {
      const parsed = Number.parseInt(values[key] ?? '', 10);
      return Number.isFinite(parsed) ? parsed : current;
    };
    const asBool = (key: string, current: boolean): boolean => {
      if (!(key in values)) return current;
      return ['1', 'true', 'yes', 'on'].includes(String(values[key]).trim().toLowerCase());
    };

    if ('provider' in values) {
      const candidate = (values.provider || 'mock').trim().toLowerCase();
      this.provider = isProvider(candidate) ? candidate : 'mock';
    }
    if ('model' in values) {
      this.model = values.model.trim() || defaultModelFor(this.provider);
    }
    if ('api_key' in values) this.apiKey = values.api_key.trim();
    if ('base_url' in values) this.baseUrl = cleanUrl(values.base_url);
    if ('anthropic_api_key' in values) this.anthropicApiKey = values.anthropic_api_key.trim();
    if ('anthropic_base_url' in values) this.anthropicBaseUrl = cleanUrl(values.anthropic_base_url);
    if ('ollama_base_url' in values) this.ollamaBaseUrl = cleanUrl(values.ollama_base_url);
    if ('opencode_api_key' in values) this.opencodeApiKey = values.opencode_api_key.trim();
    if ('opencode_base_url' in values) this.opencodeBaseUrl = cleanUrl(values.opencode_base_url);
    if ('temperature' in values) this.temperature = asFloat('temperature', this.temperature);
    if ('max_tokens' in values) this.maxTokens = asInt('max_tokens', this.maxTokens);
    if ('timeout' in values) this.timeout = asFloat('timeout', this.timeout);
    if ('max_agent_steps' in values) this.maxAgentSteps = asInt('max_agent_steps', this.maxAgentSteps);
    if ('max_build_iterations' in values) {
      this.maxBuildIterations = Math.max(1, asInt('max_build_iterations', this.maxBuildIterations));
    }
    if ('allow_heuristic_fallback' in values) {
      this.allowHeuristicFallback = asBool('allow_heuristic_fallback', this.allowHeuristicFallback);
    }
    if ('host' in values) this.host = values.host.trim() || '127.0.0.1';
    if ('port' in values) this.port = asInt('port', this.port);
    if ('agents_dir' in values) {
      this.agentsDir = path.resolve(values.agents_dir.trim() || this.agentsDir);
    }
    if ('repos_dir' in values) {
      this.reposDir = path.resolve(values.repos_dir.trim() || this.reposDir);
    }
    if ('setup_complete' in values) {
      this.setupComplete = asBool('setup_complete', this.setupComplete);
    }
    if ('ticket_prefix' in values) {
      const prefix = values.ticket_prefix.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
      this.ticketPrefix = prefix || 'CAREER';
    }
    if ('github_enabled' in values) this.githubEnabled = asBool('github_enabled', this.githubEnabled);
    if ('github_owner' in values) this.githubOwner = values.github_owner.trim() || 'levg88';
    if ('github_repo' in values) this.githubRepo = values.github_repo.trim() || 'career-firm';
    if ('github_project_title' in values) {
      this.githubProjectTitle = values.github_project_title.trim() || 'Career Team';
    }
    if ('github_project_number' in values) {
      this.githubProjectNumber = Math.max(0, asInt('github_project_number', this.githubProjectNumber));
    }
    if ('github_auto_create' in values) {
      this.githubAutoCreateProject = asBool('github_auto_create', this.githubAutoCreateProject);
    }
    if ('github_default_assignee' in values) {
      this.githubDefaultAssignee = values.github_default_assignee.trim();
    }
    if ('github_assignees_json' in values) {
      try {
        const parsed = JSON.parse(values.github_assignees_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.githubAssigneeLogins = Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]),
          );
        }
      } catch {
        // Ignore malformed mappings; issues stay unassigned when no login is known.
      }
    }
    if ('github_token' in values) this.githubToken = values.github_token.trim();
    if ('role_models' in values) {
      try {
        this.roleModels = JSON.parse(values.role_models);
      } catch {
        // ignore malformed
      }
    }
    if ('role_base_urls' in values) {
      try {
        this.roleBaseUrls = JSON.parse(values.role_base_urls);
      } catch {
        // ignore malformed
      }
    }
    if ('concierge_provider' in values) this.conciergeProvider = String(values.concierge_provider).trim();
    if ('concierge_model' in values) this.conciergeModel = String(values.concierge_model).trim();
    if ('concierge_base_url' in values) this.conciergeBaseUrl = String(values.concierge_base_url).trim();
    if ('concierge_api_key' in values) this.conciergeApiKey = String(values.concierge_api_key).trim();
    if ('concierge_fallback_models' in values) {
      const raw = String(values.concierge_fallback_models).trim();
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.conciergeFallbackModels = parsed.map((x) => String(x));
        else this.conciergeFallbackModels = raw.split(',').map((s) => s.trim()).filter(Boolean);
      } catch {
        this.conciergeFallbackModels = raw.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    if ('agent_provider' in values) this.agentProvider = String(values.agent_provider).trim();
    if ('agent_model' in values) this.agentModel = String(values.agent_model).trim();
    if ('agent_base_url' in values) this.agentBaseUrl = String(values.agent_base_url).trim();
    if ('agent_api_key' in values) this.agentApiKey = String(values.agent_api_key).trim();
    if ('agent_fallback_models' in values) {
      const raw = String(values.agent_fallback_models).trim();
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.agentFallbackModels = parsed.map((x) => String(x));
        else this.agentFallbackModels = raw.split(',').map((s) => s.trim()).filter(Boolean);
      } catch {
        this.agentFallbackModels = raw.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  get githubConfigured(): boolean {
    return Boolean(this.githubEnabled && this.githubOwner && this.githubRepo);
  }

  configValues(options: { includeSecrets?: boolean } = {}): Record<string, string> {
    const values: Record<string, string> = {
      provider: this.provider,
      model: this.model,
      base_url: this.baseUrl,
      anthropic_base_url: this.anthropicBaseUrl,
      ollama_base_url: this.ollamaBaseUrl,
      opencode_base_url: this.opencodeBaseUrl,
      temperature: String(this.temperature),
      max_tokens: String(this.maxTokens),
      timeout: String(this.timeout),
      max_agent_steps: String(this.maxAgentSteps),
      max_build_iterations: String(this.maxBuildIterations),
      allow_heuristic_fallback: this.allowHeuristicFallback ? 'true' : 'false',
      host: this.host,
      port: String(this.port),
      agents_dir: this.agentsDir,
      repos_dir: this.reposDir,
      setup_complete: this.setupComplete ? 'true' : 'false',
      ticket_prefix: this.ticketPrefix,
      github_enabled: this.githubEnabled ? 'true' : 'false',
      github_owner: this.githubOwner,
      github_repo: this.githubRepo,
      github_project_title: this.githubProjectTitle,
      github_project_number: String(this.githubProjectNumber),
      github_auto_create: this.githubAutoCreateProject ? 'true' : 'false',
      github_default_assignee: this.githubDefaultAssignee,
      github_assignees_json: JSON.stringify(this.githubAssigneeLogins),
      role_models: JSON.stringify(this.roleModels),
      role_base_urls: JSON.stringify(this.roleBaseUrls),
      concierge_provider: this.conciergeProvider,
      concierge_model: this.conciergeModel,
      concierge_base_url: this.conciergeBaseUrl,
      concierge_api_key: options.includeSecrets ? this.conciergeApiKey : '',
      concierge_fallback_models: JSON.stringify(this.conciergeFallbackModels),
      agent_provider: this.agentProvider,
      agent_model: this.agentModel,
      agent_base_url: this.agentBaseUrl,
      agent_api_key: options.includeSecrets ? this.agentApiKey : '',
      agent_fallback_models: JSON.stringify(this.agentFallbackModels),
    };
    if (options.includeSecrets) {
      values.api_key = this.apiKey;
      values.anthropic_api_key = this.anthropicApiKey;
      values.opencode_api_key = this.opencodeApiKey;
      values.github_token = this.githubToken;
    }
    return values;
  }

  get activeApiKey(): string {
    if (this.provider === 'anthropic') return this.anthropicApiKey;
    if (this.provider === 'opencode') return this.opencodeApiKey;
    return this.apiKey;
  }

  get activeBaseUrl(): string {
    if (this.provider === 'anthropic') return this.anthropicBaseUrl;
    if (this.provider === 'ollama') return this.ollamaBaseUrl;
    if (this.provider === 'opencode') return this.opencodeBaseUrl;
    return this.baseUrl;
  }

  get apiKeyHint(): string {
    const key = this.activeApiKey;
    if (!key) return '';
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 3)}…${key.slice(-4)}`;
  }

  publicDict(): Record<string, unknown> {
    return {
      provider: this.provider,
      model: this.model,
      base_url: this.provider === 'mock' ? '' : this.baseUrl,
      data_dir: this.dataDir,
      db_path: this.dbPath,
      runs_dir: this.runsDir,
      agents_dir: this.agentsDir,
      repos_dir: this.reposDir,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      max_agent_steps: this.maxAgentSteps,
      max_build_iterations: this.maxBuildIterations,
      heuristic_fallback: this.allowHeuristicFallback,
      setup_complete: this.setupComplete,
      api_key_hint: this.apiKeyHint,
      ticket_prefix: this.ticketPrefix,
      github_enabled: this.githubEnabled,
      github_configured: this.githubConfigured,
      github_owner: this.githubOwner,
      github_repo: this.githubRepo,
      github_project_title: this.githubProjectTitle,
      github_project_number: this.githubProjectNumber,
      github_default_assignee: this.githubDefaultAssignee,
      github_token_hint: this.githubTokenHint,
      role_models: this.roleModels,
      role_base_urls: this.roleBaseUrls,
      concierge_provider: this.conciergeProvider,
      concierge_model: this.conciergeModel,
      concierge_base_url: this.conciergeBaseUrl,
      concierge_fallback_models: this.conciergeFallbackModels,
      agent_provider: this.agentProvider,
      agent_model: this.agentModel,
      agent_base_url: this.agentBaseUrl,
      agent_fallback_models: this.agentFallbackModels,
    };
  }

  get githubTokenHint(): string {
    // Never expose token material, not even a prefix/suffix.
    return this.githubToken ? 'configured (hidden)' : '';
  }
}
