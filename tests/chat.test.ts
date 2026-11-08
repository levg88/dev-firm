import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/api/app';
import { ChatService } from '../src/chat/agent';
import { RepoCatalog } from '../src/chat/repos';
import * as db from '../src/db';
import { LLMClient, LLMResponse, response } from '../src/llm/base';
import { makeSettings } from './helpers';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(root: string, name: string, description: string, source: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, description, scripts: { test: 'vitest run' } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\n${description}\n`);
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), source);
  return dir;
}

class ScriptedLLM extends LLMClient {
  provider = 'scripted';
  model = 'scripted';
  responses: LLMResponse[];
  calls: Record<string, any>[][] = [];

  constructor(responses: LLMResponse[]) {
    super();
    this.responses = [...responses];
  }

  async complete(messages: Record<string, any>[]): Promise<LLMResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const next = this.responses.shift();
    if (!next) throw new Error('ScriptedLLM ran out of responses');
    return next;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('repository catalog', () => {
  it('lists repos and resolves casual names', () => {
    const root = tempDir('dev-firm-repos-');
    makeRepo(root, 'career-firm', 'Career search workspace', 'export const career = 1;\n');
    makeRepo(root, 'niw-tracker', 'NIW case tracker', 'export const niw = 1;\n');

    const catalog = new RepoCatalog(root);
    const repos = catalog.list();
    expect(repos.map((repo) => repo.name)).toEqual(['career-firm', 'niw-tracker']);
    expect(repos[0].description).toBe('Career search workspace');

    expect(catalog.resolve('career firm').name).toBe('career-firm');
    expect(catalog.resolve('the tracker').name).toBe('niw-tracker');
    expect(catalog.resolve('levg88/niw-tracker').name).toBe('niw-tracker');
  });

  it('reads and searches inside a repository without escaping it', () => {
    const root = tempDir('dev-firm-repos-');
    const repo = makeRepo(
      root,
      'career-firm',
      'Career search workspace',
      'export function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
    );

    const catalog = new RepoCatalog(root);
    const found = catalog.search('career firm', 'greet');
    expect(found.matches).toEqual([
      { file: 'src/index.ts', line: 1, text: 'export function greet(name: string) {' },
    ]);

    const read = catalog.readFile('career-firm', 'src/index.ts');
    expect(read.content).toContain('Hello');

    expect(() => catalog.readFile('career-firm', '../../etc/passwd')).toThrow(/escapes/);
    expect(() => catalog.resolve('/etc')).toThrow(/must live under/);
    expect(() => catalog.resolve('missing-repo')).toThrow(/could not find/i);
    expect(repo).toContain('career-firm');
  });
});

describe('chat concierge', () => {
  it('uses repository tools and carries conversation history into the model call', async () => {
    const root = tempDir('dev-firm-repos-');
    makeRepo(
      root,
      'career-firm',
      'Career search workspace',
      'export function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
    );

    const settings = makeSettings();
    settings.reposDir = root;
    settings.maxAgentSteps = 8;

    const llm = new ScriptedLLM([
      response({
        toolCalls: [
          {
            id: 'call_1',
            name: 'search_repo_code',
            arguments: { repo: 'the career repo', query: 'greet' },
          },
        ],
      }),
      response({ text: '`greet` is defined in `src/index.ts`.' }),
    ]);

    const service = new ChatService(settings, { llm });
    const result = await service.run('Where is greet defined in the career repo?', [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ]);

    expect(result.reply).toContain('src/index.ts');
    expect(result.workflowId).toBeNull();
    expect(result.metadata.tool_calls).toHaveLength(1);
    expect(result.metadata.repos).toEqual(['career-firm']);

    const firstCall = llm.calls[0];
    expect(firstCall.some((message) => message.role === 'assistant' && message.content === 'Earlier answer')).toBe(true);
    expect(firstCall[firstCall.length - 1].content).toBe('Where is greet defined in the career repo?');
  });

  it('recovers a text-emitted repo_overview tool call and executes it', async () => {
    const root = tempDir('dev-firm-repos-');
    makeRepo(
      root,
      'career-firm',
      'Career search workspace',
      'export function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
    );

    const settings = makeSettings();
    settings.reposDir = root;
    settings.maxAgentSteps = 8;

    const llm = new ScriptedLLM([
      response({
        text:
          'Let me check that repo.\\n```json\\n' +
          JSON.stringify({ name: 'repo_overview', arguments: { repo: 'career-firm' } }) +
          '\\n```',
      }),
      response({ text: 'career-firm is a career search workspace.' }),
    ]);

    const service = new ChatService(settings, { llm });
    const result = await service.run('Tell me about the career repo', []);

    expect(result.reply).toContain('career search workspace');
    expect(result.metadata.tool_calls).toHaveLength(1);
    expect(result.metadata.tool_calls[0].name).toBe('repo_overview');
    expect(result.metadata.repos).toContain('career-firm');
  });

  it('starts a build against the resolved repository', async () => {
    const root = tempDir('dev-firm-repos-');
    const repoDir = makeRepo(root, 'career-firm', 'Career search workspace', 'export const career = 1;\n');
    const settings = makeSettings();
    settings.reposDir = root;

    const calls: Array<{ id: number; brief: string; path?: string }> = [];
    const llm = new ScriptedLLM([
      response({
        toolCalls: [
          {
            id: 'call_1',
            name: 'start_build',
            arguments: {
              repo: 'career firm',
              brief: 'Add a dark mode toggle to the settings page.',
              title: 'Dark mode',
            },
          },
        ],
      }),
      response({ text: 'Started build #1 for career-firm.' }),
    ]);

    const service = new ChatService(settings, {
      llm,
      startBuildRunner: (id, brief, repoPath) => calls.push({ id, brief, path: repoPath }),
    });
    const result = await service.run('Add dark mode to career-firm', []);

    expect(result.workflowId).toBeTypeOf('number');
    expect(result.metadata.started_builds).toEqual([
      { id: result.workflowId, repo: 'career-firm', title: 'Dark mode' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(fs.realpathSync(repoDir));

    const workflow = db.withSession(settings.dbPath, (conn) =>
      db.getWorkflow(conn, result.workflowId as number),
    );
    expect(workflow?.title).toBe('Dark mode');
    expect(workflow?.input.brief).toBe('Add a dark mode toggle to the settings page.');
    expect(workflow?.input.repo_path).toBe(fs.realpathSync(repoDir));
  });

  it('falls back to a useful offline reply when no provider is configured', async () => {
    const root = tempDir('dev-firm-repos-');
    makeRepo(root, 'career-firm', 'Career search workspace', 'export const career = 1;\n');

    const settings = makeSettings();
    settings.reposDir = root;
    const app = createApp(settings);
    const agent = request(app);

    const sent = await agent.post('/api/chat').send({ content: 'How does the career repo work?' });
    expect(sent.status).toBe(200);
    expect(sent.body.user_message.content).toBe('How does the career repo work?');
    expect(sent.body.assistant_message).toContain('offline mode');

    const repos = await agent.get('/api/repos');
    expect(repos.status).toBe(200);
    expect(repos.body.root).toBe(root);
    expect(repos.body.repositories[0].name).toBe('career-firm');

    const chat = await agent.get('/api/chat');
    expect(chat.body.messages).toHaveLength(2);
    expect(chat.body.messages[1].agent_role).toBe('concierge');
  });
});
