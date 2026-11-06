import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as db from '../src/db';
import { Agent, ToolRegistry } from '../src/agents/base';
import { runAgent } from '../src/agents/runner';
import { Sandbox, makeTools } from '../src/agents/tools';
import {
  LLMClient,
  LLMResponse,
  parseJsonObject,
  response,
} from '../src/llm/base';
import { makeSettings } from './helpers';

class ScriptedLLM extends LLMClient {
  provider = 'scripted';
  model = 'scripted';
  responses: LLMResponse[];

  constructor(responses: LLMResponse[]) {
    super();
    this.responses = [...responses];
  }

  async complete(): Promise<LLMResponse> {
    const next = this.responses.shift();
    if (!next) throw new Error('ScriptedLLM ran out of responses');
    return next;
  }
}

const Answer = z.object({ ok: z.boolean() });

function makeAgent(
  llm: LLMClient,
  tools?: ToolRegistry,
): InstanceType<typeof Agent> {
  return new Agent(
    { name: 'tester', role: 'tester', systemPrompt: 'Test.' },
    llm,
    makeSettings(),
    tools,
  );
}

describe('agent runtime', () => {
  it('executes tool calls before answering', async () => {
    const sandbox = new Sandbox('/tmp');
    const registry = makeTools(sandbox);
    const calls: string[] = [];
    void calls;
    const llm = new ScriptedLLM([
      response({ toolCalls: [{ id: '1', name: 'write_file', arguments: { path: 'a.txt', content: 'hi' } }] }),
      response({ text: '{"ok": true}' }),
    ]);
    const result = await makeAgent(llm, registry).run('do it', { schema: Answer });
    expect(result.data).toEqual({ ok: true });
    expect(result.steps).toBe(2);
  });

  it('retries invalid JSON once', async () => {
    const llm = new ScriptedLLM([response({ text: 'not json' }), response({ text: '{"ok": true}' })]);
    const result = await makeAgent(llm).run('do it', { schema: Answer });
    expect(result.data).toEqual({ ok: true });
  });

  it('reports unknown tools without aborting the run', async () => {
    const registry = makeTools(new Sandbox('/tmp'));
    const llm = new ScriptedLLM([
      response({ toolCalls: [{ id: '1', name: 'nope', arguments: {} }] }),
      response({ text: '{"ok": true}' }),
    ]);
    const result = await makeAgent(llm, registry).run('do it', { schema: Answer });
    expect(result.data).toEqual({ ok: true });
  });

  it('persists an audit record for each run', async () => {
    const settings = makeSettings();
    const llm = new ScriptedLLM([response({ text: '{"ok": true}' })]);
    const agent = new Agent(
      { name: 'tester', role: 'tester', systemPrompt: 'Test.' },
      llm,
      settings,
    );
    const workflowId = db.withSession(settings.dbPath, (conn) =>
      db.createWorkflow(conn, 'test', 'test'),
    );
    const result = await runAgent(settings, agent, {
      workflow: 'test',
      role: 'tester',
      task: 'do it',
      schema: Answer,
      workflowRunId: workflowId,
    });
    expect(result.data).toEqual({ ok: true });
    const runs = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, workflowId),
    );
    expect(runs[0].role).toBe('tester');
    expect(runs[0].status).toBe('ok');
  });

  it('recovers a text-emitted tool call with braces and quotes in its arguments', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-toolcall-'));
    const fileContent = [
      'export function check(x) {',
      '  if (x) { return "}"; }',
      '  return "C:\\\\tmp";',
      '}',
      '',
    ].join('\n');
    const call = {
      name: 'write_file',
      arguments: { path: 'recovered.txt', content: fileContent },
    };
    const llm = new ScriptedLLM([
      response({ text: 'Here is the call:\n```json\n' + JSON.stringify(call) + '\n```' }),
      response({ text: '{"ok": true}' }),
    ]);

    const result = await makeAgent(llm, makeTools(new Sandbox(workspace))).run('do it', {
      schema: Answer,
    });

    expect(result.data).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(workspace, 'recovered.txt'), 'utf8')).toBe(fileContent);
  });

  it('recovers multiple text tool calls that use JSON.stringify for content', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-toolcalls-'));
    const text = [
      '```json',
      '{',
      '  "name": "write_file",',
      '  "arguments": {',
      '    "path": "package.json",',
      '    "content": JSON.stringify({',
      '      "name": "app",',
      '      "scripts": { "test": "vitest run" }',
      '    }, null, 2)',
      '  }',
      '}',
      '```',
      '```json',
      '{',
      '  "name": "write_file",',
      '  "arguments": { "path": "server.js", "content": "console.log(1)\\n" }',
      '}',
      '```',
    ].join('\n');
    const llm = new ScriptedLLM([
      response({ text }),
      response({ text: '{"ok": true}' }),
    ]);

    const result = await makeAgent(llm, makeTools(new Sandbox(workspace))).run('do it', {
      schema: Answer,
    });

    expect(result.data).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'))).toEqual({
      name: 'app',
      scripts: { test: 'vitest run' },
    });
    expect(fs.readFileSync(path.join(workspace, 'server.js'), 'utf8')).toBe('console.log(1)\n');
  });

  it('parses JSON from common model shapes', () => {
    expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Here is the result: {"a": 2}')).toEqual({ a: 2 });
    expect(parseJsonObject('{"a": 3,}')).toEqual({ a: 3 });
    expect(() => parseJsonObject('not json at all')).toThrow();
  });

  it('blocks sandbox escapes and unsafe commands', async () => {
    const sandbox = new Sandbox('/tmp');
    expect(() => sandbox.resolve('../outside.txt')).toThrow();
    await expect(sandbox.runCommand({ command: 'curl https://example.com' })).rejects.toThrow();
  });
});
