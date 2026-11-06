import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { Tool, ToolRegistry } from './base';

const execAsync = promisify(exec);

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class Sandbox {
  /** Workspace-scoped file and command tools. */
  root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  resolve(relative: unknown): string {
    const value = String(relative ?? '');
    if (!value) throw new SandboxError('A path is required');
    const resolved = path.resolve(this.root, value);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new SandboxError(`Path escapes the workspace: ${value}`);
    }
    return resolved;
  }

  readFile(args: Record<string, unknown>): string {
    const target = this.resolve(args.path);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new SandboxError(`File not found: ${String(args.path)}`);
    }
    return fs.readFileSync(target, 'utf8').slice(0, 200000);
  }

  writeFile(args: Record<string, unknown>): Record<string, unknown> {
    const target = this.resolve(args.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = String(args.content ?? '');
    fs.writeFileSync(target, content, 'utf8');
    return { ok: true, path: path.relative(this.root, target), bytes: content.length };
  }

  listFiles(args: Record<string, unknown>): string[] {
    const base = this.resolve(args.path ?? '.');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.root, full).split(path.sep).join('/');
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          walk(full);
        } else {
          files.push(rel);
          if (files.length >= 300) return;
        }
      }
    };
    if (fs.existsSync(base) && fs.statSync(base).isFile()) {
      files.push(path.relative(this.root, base).split(path.sep).join('/'));
    } else if (fs.existsSync(base)) {
      walk(base);
    }
    return files;
  }

  async runCommand(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command = String(args.command ?? '');
    const timeout = Number(args.timeout ?? 120) || 120;
    const argv = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const executable = argv[0]?.split(/["']/).pop() ?? '';
    const allowed = new Set([
      'pytest',
      'python',
      'python3',
      'pip',
      'ls',
      'cat',
      'grep',
      'rg',
      'find',
      'node',
      'npm',
      'pnpm',
      'yarn',
    ]);
    if (!allowed.has(executable)) {
      throw new SandboxError(
        `Command '${executable}' is not allowed. Allowed: ${[...allowed].join(', ')}`,
      );
    }
    const run = async (): Promise<Record<string, unknown>> => {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.root,
        timeout: timeout * 1000,
        env: {
          PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: process.env.HOME ?? '',
        },
      });
      const output = (stdout || '').slice(-30000);
      const errorText = (stderr || '').slice(-30000);
      return { ok: true, returncode: 0, stdout: output, stderr: errorText, command };
    };
    try {
      const result = await run();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('timed out')) {
        return { ok: false, error: `Timed out after ${timeout}s`, command };
      }
      return { ok: false, error: message, command };
    }
  }
}

function PathLike(value: string): string {
  // Deliberately permissive for workspace-relative paths; containment is checked after resolution.
  return value;
}

export function makeTools(sandbox: Sandbox, options: { readOnly?: boolean } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.add({
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path' } },
      required: ['path'],
    },
    handler: (args) => sandbox.readFile(args),
  });
  registry.add({
    name: 'list_files',
    description: 'List files in the workspace, optionally under a subdirectory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', default: '.' } },
    },
    handler: (args) => sandbox.listFiles(args),
  });
  if (!options.readOnly) {
    registry.add({
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file in the workspace. Always write complete file contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      handler: (args) => sandbox.writeFile(args),
    });
  }
  registry.add({
    name: 'run_command',
    description:
      'Run an allowed command in the workspace and return stdout/stderr. Use it to run tests or inspect the project.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'integer', default: 120 } },
      required: ['command'],
    },
    handler: (args) => sandbox.runCommand(args),
  });
  return registry;
}

export function artifactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
