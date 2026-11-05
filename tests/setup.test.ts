import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/api/app';
import { Settings, defaultBaseUrlFor, defaultModelFor } from '../src/config';
import * as db from '../src/db';
import { OpenAICompatClient, buildLlm } from '../src/llm';
import { applyStoredSettings } from '../src/runtime';
import { makeFreshSettings, makeSettings, restoreEnv, snapshotEnv } from './helpers';

describe('first-run setup', () => {
  it('redirects every app page to the wizard', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));
    const response = await agent.get('/');
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/setup');
    const health = await agent.get('/health');
    expect(health.body.setup_complete).toBe(false);
  });

  it('renders the setup wizard fields', async () => {
    const agent = request(createApp(makeFreshSettings()));
    const response = await agent.get('/setup');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Set up Dev Firm');
    expect(response.text).toContain('name="provider"');
    expect(response.text).toContain('name="api_key"');
    expect(response.text).toContain('name="max_agent_steps"');
    expect(response.text).not.toContain('name="cv_file"');
  });

  it('saves configuration', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));
    const response = await agent
      .post('/setup')
      .send({ provider: 'mock', model: 'mock', max_agent_steps: '20' });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/?welcome=1');
    expect(settings.setupComplete).toBe(true);
    expect(settings.provider).toBe('mock');
    expect(settings.maxAgentSteps).toBe(20);
    const stored = db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn));
    expect(stored.provider).toBe('mock');
    expect(stored.setup_complete).toBe('true');
    expect(stored.max_agent_steps).toBe('20');
    const dashboard = await agent.get('/?welcome=1');
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain('Setup complete');
  });

  it('requires a key for hosted providers', async () => {
    const agent = request(createApp(makeFreshSettings()));
    const response = await agent.post('/setup').send({ provider: 'openai', model: 'gpt-4.1' });
    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenAI API key is required');
  });

  it('masks the saved key and keeps it when left blank', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));
    const secret = 'sk-test-1234567890';
    const saved = await agent
      .post('/setup')
      .send({
        provider: 'openai',
        model: 'gpt-4.1',
        base_url: 'https://api.openai.com/v1',
        api_key: secret,
      });
    expect(saved.status).toBe(303);
    const page = await agent.get('/settings');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(secret);
    expect(page.text).toContain('sk-…7890');
    const stored = db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn));
    expect(stored.api_key).toBe(secret);

    const kept = await agent
      .post('/settings')
      .send({
        provider: 'openai',
        model: 'gpt-4.1',
        base_url: 'https://api.openai.com/v1',
        api_key: '',
      });
    expect(kept.status).toBe(303);
    expect(db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn)).api_key).toBe(secret);
  });
});

describe('OpenCode provider', () => {
  it('saves the OpenCode provider and key', async () => {
    const settings = makeFreshSettings();
    const agent = request(createApp(settings));
    const secret = 'oc_test_key_1234567890';
    const response = await agent
      .post('/setup')
      .send({
        provider: 'opencode',
        model: 'deepseek-v4.1-flash-free',
        base_url: 'https://opencode.ai/inference/openai/v1',
        api_key: secret,
      });
    expect(response.status).toBe(303);
    expect(settings.provider).toBe('opencode');
    expect(settings.model).toBe('deepseek-v4.1-flash-free');
    expect(settings.opencodeApiKey).toBe(secret);
    expect(settings.opencodeBaseUrl).toBe('https://opencode.ai/inference/openai/v1');
  });

  it('requires an OpenCode key', async () => {
    const agent = request(createApp(makeFreshSettings()));
    const response = await agent
      .post('/setup')
      .send({ provider: 'opencode', model: 'deepseek-v4.1-flash-free' });
    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenCode API key is required');
  });

  it('builds an OpenCode-compatible client', () => {
    const settings = makeFreshSettings();
    settings.provider = 'opencode';
    settings.opencodeApiKey = 'oc_test_key_1234567890';
    settings.opencodeBaseUrl = 'https://opencode.ai/inference/openai/v1';
    settings.model = 'deepseek-v4.1-flash-free';
    const llm = buildLlm(settings);
    expect(llm).toBeInstanceOf(OpenAICompatClient);
    expect(llm.provider).toBe('opencode');
    expect(llm.model).toBe('deepseek-v4.1-flash-free');
    expect((llm as OpenAICompatClient).apiKey).toBe('oc_test_key_1234567890');
  });

  it('uses OpenCode defaults and env detection', () => {
    expect(defaultModelFor('opencode')).toBe('deepseek-v4.1-flash-free');
    expect(defaultBaseUrlFor('opencode')).toBe('https://opencode.ai/inference/openai/v1');

    const snapshot = snapshotEnv();
    try {
      const settings = makeSettings();
      process.env.DEV_FIRM_HOME = settings.home;
      delete process.env.DEV_FIRM_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENCODE_API_KEY = 'oc_test_key_1234567890';
      const detected = Settings.load();
      expect(detected.provider).toBe('opencode');
      expect(detected.opencodeApiKey).toBe('oc_test_key_1234567890');
    } finally {
      restoreEnv(snapshot);
    }
  });
});

describe('stored settings', () => {
  it('are applied by the CLI runtime', () => {
    const settings = makeSettings();
    db.withSession(settings.dbPath, (conn) => {
      db.saveAppSettings(conn, { provider: 'ollama', model: 'llama3.1', setup_complete: 'true' });
    });
    const snapshot = snapshotEnv();
    try {
      const loaded = applyStoredSettings(settings);
      expect(loaded.provider).toBe('ollama');
      expect(loaded.model).toBe('llama3.1');
      expect(loaded.setupComplete).toBe(true);
    } finally {
      restoreEnv(snapshot);
    }
  });
});
