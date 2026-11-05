import fs from 'node:fs';
import path from 'node:path';

export const OPENCODE_BASE_URL = 'https://opencode.ai/inference/openai/v1';

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

const PROVIDERS = ['openai', 'anthropic', 'ollama', 'opencode', 'mock'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

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

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envFloat(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

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

export function defaultBaseUrlFor(provider: string): string {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    ollama: 'http://localhost:11434/v1',
    opencode: OPENCODE_BASE_URL,
  };
  return urls[provider] ?? '';
}

function defaultModel(provider: Provider): string {
  return process.env.DEV_FIRM_MODEL || defaultModelFor(provider);
}

function cleanUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export class Settings {
  home: string;
  dataDir: string;
  dbPath: string;
  storageDir: string;
  runsDir: string;
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
  allowHeuristicFallback: boolean;
  host: string;
  port: number;
  setupComplete: boolean;

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
    allowHeuristicFallback: boolean;
    host: string;
    port: number;
    setupComplete: boolean;
  }) {
    this.home = values.home;
    this.dataDir = values.home;
    this.dbPath = path.join(values.home, 'dev.db');
    this.storageDir = path.join(values.home, 'storage');
    this.runsDir = path.join(values.home, 'runs');
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
    this.allowHeuristicFallback = values.allowHeuristicFallback;
    this.host = values.host;
    this.port = values.port;
    this.setupComplete = values.setupComplete;
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
      timeout: envFloat('DEV_FIRM_TIMEOUT', 180),
      maxAgentSteps: envInt('DEV_FIRM_MAX_STEPS', 16),
      allowHeuristicFallback: envBool('DEV_FIRM_HEURISTIC_FALLBACK', true),
      host: process.env.DEV_FIRM_HOST || '127.0.0.1',
      port: envInt('DEV_FIRM_PORT', 8766),
      setupComplete: envBool('DEV_FIRM_SETUP_COMPLETE', envConfigured),
    });
    settings.ensureDirs();
    return settings;
  }

  ensureDirs(): void {
    for (const dir of [this.dataDir, this.storageDir, this.runsDir]) {
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
    if ('allow_heuristic_fallback' in values) {
      this.allowHeuristicFallback = asBool('allow_heuristic_fallback', this.allowHeuristicFallback);
    }
    if ('host' in values) this.host = values.host.trim() || '127.0.0.1';
    if ('port' in values) this.port = asInt('port', this.port);
    if ('setup_complete' in values) {
      this.setupComplete = asBool('setup_complete', this.setupComplete);
    }
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
      allow_heuristic_fallback: this.allowHeuristicFallback ? 'true' : 'false',
      host: this.host,
      port: String(this.port),
      setup_complete: this.setupComplete ? 'true' : 'false',
    };
    if (options.includeSecrets) {
      values.api_key = this.apiKey;
      values.anthropic_api_key = this.anthropicApiKey;
      values.opencode_api_key = this.opencodeApiKey;
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
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      max_agent_steps: this.maxAgentSteps,
      heuristic_fallback: this.allowHeuristicFallback,
      setup_complete: this.setupComplete,
      api_key_hint: this.apiKeyHint,
    };
  }
}
