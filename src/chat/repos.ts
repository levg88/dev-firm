/**
 * @fileoverview Local repository discovery and read-only inspection.
 *
 * The chat concierge uses this module to resolve a casual repo name (for
 * example "career firm" or "the tracker") to a real checkout and to answer
 * questions by reading its files. All reads are confined to the resolved
 * repository root.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A repository the firm can inspect or build against. */
export interface RepoEntry {
  name: string;
  path: string;
  description: string;
}

/** Error raised when a repository cannot be resolved or inspected. */
export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoError';
  }
}

/** Directories that add noise without helping a conversation. */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'target',
  'vendor',
  'Pods',
]);

/** Text file extensions worth searching or reading in a normal repo. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.ejs',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.sql',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.cs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.txt',
  '.env.example',
]);

const MAX_SEARCH_FILES = 4000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_LIST_FILES = 400;

/** Expand `~` and resolve a path against a base directory. */
function expandPath(value: string, base: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (trimmed === '~') return process.env.HOME || base;
  if (trimmed.startsWith('~/')) return path.join(process.env.HOME || base, trimmed.slice(2));
  return path.resolve(base, trimmed);
}

/** Normalise a repo name for fuzzy matching. */
function normalizeName(value: string): string {
  return value
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '')
    .replace(/^-+|-+$/g, '');
}

/** True when a directory looks like a git checkout. */
function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Read a small text file, returning '' when it is missing or unreadable. */
function readText(file: string, maxBytes = 128 * 1024): string {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Pull a one-line description from package.json or the README. */
function describeRepo(dir: string): string {
  const pkg = readText(path.join(dir, 'package.json'), 64 * 1024);
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      if (typeof parsed.description === 'string' && parsed.description.trim()) {
        return parsed.description.trim();
      }
    } catch {
      // Fall through to the README.
    }
  }
  for (const name of ['README.md', 'readme.md', 'README', 'README.txt']) {
    const text = readText(path.join(dir, name), 64 * 1024);
    if (!text) continue;
    const line = text
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry && !entry.startsWith('#') && !entry.startsWith('>') && !entry.startsWith('```'));
    if (line) return line.replace(/[*_`]/g, '').slice(0, 240);
  }
  return '';
}

/** Convert a simple glob (`*.ts`, `src/**\/*.ts`) into a RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True when a file has an extension the catalog treats as text. */
function isTextFile(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (base === '.env.example' || base === 'dockerfile' || base === 'makefile') return true;
  const ext = path.extname(file).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Repository catalog rooted at a directory. It lists git checkouts directly
 * below the root and resolves a user/model supplied name to exactly one repo.
 */
export class RepoCatalog {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** List the git repositories directly below the root. */
  list(): RepoEntry[] {
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) return [];
    const entries: RepoEntry[] = [];
    for (const dirent of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const full = path.join(this.root, dirent.name);
      if (!isGitRepo(full) || !this.insideRoot(full)) continue;
      entries.push({
        name: dirent.name,
        path: this.real(full),
        description: describeRepo(full),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve a repo name, relative path, or absolute path to a checkout.
   * Throws {@link RepoError} with the available names when it cannot decide.
   */
  resolve(input: string): RepoEntry {
    const raw = String(input ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!raw) {
      throw new RepoError(
        `Which repository should I use? I can see: ${this.names() || '(none configured)'}.`,
      );
    }

    // `owner/repo` is a common way to name a GitHub repository.
    const slashName = raw.includes('/') && !raw.startsWith('/') && !raw.startsWith('.')
      ? raw.split('/').filter(Boolean).pop() ?? raw
      : raw;

    // Absolute or explicitly relative paths are accepted when they exist and
    // stay inside the configured repositories folder.
    if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('~')) {
      const candidate = expandPath(raw, this.root);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        if (!this.insideRoot(candidate)) {
          throw new RepoError(
            `For safety, repositories must live under ${this.root}. ` +
              'Change the repositories folder in Settings if this checkout is elsewhere.',
          );
        }
        const real = this.real(candidate);
        return {
          name: path.basename(real),
          path: real,
          description: describeRepo(real),
        };
      }
      throw new RepoError(`I could not find a directory at ${candidate}.`);
    }

    const repos = this.list();
    const wanted = normalizeName(slashName);
    const exact = repos.find((repo) => normalizeName(repo.name) === wanted);
    if (exact) return exact;

    // Casual references ("the career repo", "that tracker") should still match.
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'my',
      'our',
      'repo',
      'repository',
      'project',
      'codebase',
      'folder',
      'in',
      'for',
      'of',
      'to',
      'that',
      'this',
    ]);
    const tokens = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token && !stopWords.has(token));
    const tokenMatches = repos.filter((repo) => {
      const name = normalizeName(repo.name);
      return tokens.some((token) => name.includes(token));
    });
    if (tokenMatches.length === 1) return tokenMatches[0];

    const partial = repos.filter((repo) => {
      const name = normalizeName(repo.name);
      return name.includes(wanted) || wanted.includes(name);
    });
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new RepoError(
        `"${raw}" matches more than one repository: ${partial.map((repo) => repo.name).join(', ')}. ` +
          'Which one did you mean?',
      );
    }

    if (tokenMatches.length > 1) {
      throw new RepoError(
        `"${raw}" matches more than one repository: ${tokenMatches.map((repo) => repo.name).join(', ')}. ` +
          'Which one did you mean?',
      );
    }

    // A relative path below the catalog root is also valid.
    const belowRoot = path.resolve(this.root, raw);
    if (
      belowRoot.startsWith(this.root + path.sep) &&
      fs.existsSync(belowRoot) &&
      fs.statSync(belowRoot).isDirectory() &&
      this.insideRoot(belowRoot)
    ) {
      const real = this.real(belowRoot);
      return {
        name: path.basename(real),
        path: real,
        description: describeRepo(real),
      };
    }

    throw new RepoError(
      `I could not find a repository called "${raw}". I can see: ${this.names() || '(none configured)'}. ` +
        `If it is not cloned yet, put it under ${this.root} or give me its absolute path.`,
    );
  }

  /** Comma-separated names of the repositories the catalog can see. */
  names(): string {
    return this.list().map((repo) => repo.name).join(', ');
  }

  /** Concise overview: description, top-level layout, package metadata, README. */
  overview(input: string): Record<string, unknown> {
    const repo = this.resolve(input);
    const topLevel = fs
      .readdirSync(repo.path, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .filter((entry) => !SKIP_DIRS.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
      .slice(0, 120);

    const packageJson = readText(path.join(repo.path, 'package.json'));
    let pkg: Record<string, unknown> | null = null;
    if (packageJson) {
      try {
        const parsed = JSON.parse(packageJson) as Record<string, any>;
        pkg = {
          name: parsed.name,
          version: parsed.version,
          description: parsed.description,
          scripts: parsed.scripts ?? {},
          dependencies: Object.keys(parsed.dependencies ?? {}).slice(0, 80),
          dev_dependencies: Object.keys(parsed.devDependencies ?? {}).slice(0, 80),
        };
        if (parsed.workspaces) pkg.workspaces = parsed.workspaces;
      } catch {
        pkg = null;
      }
    }

    const readme = ['README.md', 'readme.md', 'README', 'README.txt']
      .map((name) => readText(path.join(repo.path, name), 96 * 1024))
      .find(Boolean);

    return {
      repo: repo.name,
      path: repo.path,
      description: repo.description,
      top_level: topLevel,
      package: pkg,
      readme_excerpt: readme ? readme.slice(0, 6000) : null,
      has_agents_md: fs.existsSync(path.join(repo.path, 'AGENTS.md')),
      has_context: fs.existsSync(path.join(repo.path, 'Context')),
    };
  }

  /** List files below a repo subdirectory, relative to the repo root. */
  listFiles(input: string, subpath = '.', depth = 3): Record<string, unknown> {
    const repo = this.resolve(input);
    const start = this.safeResolve(repo.path, subpath || '.');
    if (!fs.existsSync(start)) throw new RepoError(`Path not found in ${repo.name}: ${subpath}`);
    const startStat = fs.statSync(start);
    if (startStat.isFile()) {
      return { repo: repo.name, path: subpath, files: [path.basename(start)] };
    }

    const rootDepth = start === repo.path ? 0 : path.relative(repo.path, start).split(path.sep).length;
    const files: string[] = [];
    const walk = (dir: string): void => {
      if (files.length >= MAX_LIST_FILES) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(repo.path, full).split(path.sep).join('/');
        const entryDepth = relative.split('/').length;
        if (entry.isDirectory()) {
          if (entryDepth - rootDepth < depth) walk(full);
        } else {
          files.push(relative);
          if (files.length >= MAX_LIST_FILES) return;
        }
      }
    };
    walk(start);
    return {
      repo: repo.name,
      path: path.relative(repo.path, start).split(path.sep).join('/') || '.',
      files,
      truncated: files.length >= MAX_LIST_FILES,
    };
  }

  /** Read a UTF-8 file from a repo, rejecting paths outside the checkout. */
  readFile(input: string, filePath: string, maxChars = 40000): Record<string, unknown> {
    const repo = this.resolve(input);
    const target = this.safeResolve(repo.path, filePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new RepoError(`File not found in ${repo.name}: ${filePath}`);
    }
    const text = fs.readFileSync(target, 'utf8');
    const limit = Math.min(Math.max(Number(maxChars) || 40000, 1000), 200000);
    return {
      repo: repo.name,
      path: path.relative(repo.path, target).split(path.sep).join('/'),
      content: text.slice(0, limit),
      truncated: text.length > limit,
    };
  }

  /** Search text files in a repo for a literal string or regular expression. */
  search(
    input: string,
    query: string,
    options: { fileGlob?: string; isRegex?: boolean; limit?: number } = {},
  ): Record<string, unknown> {
    const repo = this.resolve(input);
    const needle = String(query ?? '');
    if (!needle.trim()) throw new RepoError('A search query is required.');

    let matcher: RegExp;
    if (options.isRegex) {
      try {
        matcher = new RegExp(needle, 'i');
      } catch (error) {
        throw new RepoError(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const glob = options.fileGlob?.trim() ? globToRegExp(options.fileGlob.trim()) : null;
    const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 200);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    let scanned = 0;
    let scannedBytes = 0;
    let truncated = false;

    const walk = (dir: string): void => {
      if (truncated || scanned >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (truncated || scanned >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) return;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !isTextFile(full)) continue;
        const relative = path.relative(repo.path, full).split(path.sep).join('/');
        if (glob && !glob.test(relative) && !glob.test(entry.name)) continue;
        scanned += 1;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
        if (scannedBytes + stat.size > MAX_SEARCH_TOTAL_BYTES) {
          truncated = true;
          return;
        }
        scannedBytes += stat.size;
        let text: string;
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!matcher.test(lines[index])) continue;
          matches.push({
            file: relative,
            line: index + 1,
            text: lines[index].trim().slice(0, 300),
          });
          if (matches.length >= limit) {
            truncated = true;
            return;
          }
        }
      }
    };

    walk(repo.path);
    return {
      repo: repo.name,
      query: needle,
      matches,
      files_scanned: scanned,
      truncated:
        truncated || scanned >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES,
    };
  }

  /** Resolve a path and ensure it stays inside the repository root. */
  private safeResolve(root: string, relative: string): string {
    const target = path.resolve(root, String(relative || '.'));
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new RepoError(`Path escapes the repository: ${relative}`);
    }
    if (fs.existsSync(target)) {
      const realTarget = this.real(target);
      const realRoot = this.real(root);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw new RepoError(`Path escapes the repository: ${relative}`);
      }
      return realTarget;
    }
    return target;
  }

  /** Resolve symlinks when possible. */
  private real(value: string): string {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  }

  /** True when a path resolves to the catalog root or a directory below it. */
  private insideRoot(value: string): boolean {
    const realValue = this.real(value);
    const realRoot = this.real(this.root);
    return realValue === realRoot || realValue.startsWith(realRoot + path.sep);
  }
}
