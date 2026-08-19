import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// 安全检查：防止路径遍历攻击
function isPathSafe(targetPath, basePath) {
  const resolved = path.resolve(targetPath);
  const base = path.resolve(basePath);
  return resolved.startsWith(base);
}

export function registerFileRoutes(app) {
  // 获取指定目录的文件树
  app.post('/api/files/tree', async (req, reply) => {
    const { cwd } = req.body || {};
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd is required' });
    }

    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'cwd must be a directory' });
      }

      const tree = await buildFileTree(cwd, cwd, 0);
      return { tree };
    } catch (err) {
      app.log.error({ err, cwd }, 'Failed to build file tree');
      return reply.code(500).send({ error: String(err.message || err) });
    }
  });

  // 读取文件内容
  app.post('/api/files/read', async (req, reply) => {
    const { filePath, cwd } = req.body || {};
    if (!filePath || !cwd) {
      return reply.code(400).send({ error: 'filePath and cwd are required' });
    }

    const fullPath = path.resolve(cwd, filePath);
    if (!isPathSafe(fullPath, cwd)) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return { content, path: filePath };
    } catch (err) {
      app.log.error({ err, filePath }, 'Failed to read file');
      return reply.code(500).send({ error: String(err.message || err) });
    }
  });

  // 获取git状态
  app.post('/api/git/status', async (req, reply) => {
    const { cwd } = req.body || {};
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd is required' });
    }

    try {
      // 检查是否是git仓库
      await execAsync('git rev-parse --git-dir', { cwd });

      // 获取状态
      const { stdout } = await execAsync('git status --porcelain', { cwd });
      const files = parseGitStatus(stdout);

      return { files };
    } catch (err) {
      if (err.code === 128) {
        return { files: [], error: 'Not a git repository' };
      }
      app.log.error({ err, cwd }, 'Failed to get git status');
      return reply.code(500).send({ error: String(err.message || err) });
    }
  });

  // 获取git diff
  app.post('/api/git/diff', async (req, reply) => {
    const { filePath, cwd } = req.body || {};
    if (!filePath || !cwd) {
      return reply.code(400).send({ error: 'filePath and cwd are required' });
    }

    try {
      const { stdout } = await execAsync(`git diff HEAD -- ${JSON.stringify(filePath)}`, { cwd });
      return { diff: stdout, path: filePath };
    } catch (err) {
      app.log.error({ err, filePath }, 'Failed to get git diff');
      return reply.code(500).send({ error: String(err.message || err) });
    }
  });
}

// 构建文件树（递归，限制深度）
async function buildFileTree(basePath, currentPath, depth) {
  if (depth > 5) return null; // 限制深度防止太深

  const name = path.basename(currentPath);
  const relativePath = path.relative(basePath, currentPath);

  const stat = await fs.stat(currentPath);

  if (stat.isFile()) {
    return {
      name,
      path: relativePath || '.',
      type: 'file',
      size: stat.size,
    };
  }

  if (stat.isDirectory()) {
    // 跳过常见的不需要显示的目录
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') {
      return null;
    }

    const entries = await fs.readdir(currentPath);
    const children = await Promise.all(
      entries.map(entry => buildFileTree(basePath, path.join(currentPath, entry), depth + 1))
    );

    return {
      name,
      path: relativePath || '.',
      type: 'directory',
      children: children.filter(Boolean).sort((a, b) => {
        // 目录优先，然后按名称排序
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    };
  }

  return null;
}

// Decode a git-quoted path: strip outer double quotes and unescape escape sequences.
// Git quotes any path containing non-ASCII bytes or special characters.  Non-ASCII
// bytes are represented as individual \NNN octal escapes — a multi-byte UTF-8
// sequence becomes several consecutive octal groups.  We must collect consecutive
// groups into a Buffer and decode as UTF-8, rather than treating each group as a
// Unicode code point (which would produce garbage for Chinese etc.)
function decodeGitPath(raw) {
  if (!raw.startsWith('"')) return raw;
  const inner = raw.slice(1, -1); // strip surrounding double quotes

  let result = '';
  let i = 0;
  while (i < inner.length) {
    if (inner[i] !== '\\') {
      result += inner[i++];
      continue;
    }
    // Collect all consecutive octal groups into one Buffer so that multi-byte
    // UTF-8 sequences (e.g. \346\212\200 → 汉字) decode correctly.
    const bytes = [];
    while (i < inner.length && inner[i] === '\\' && /[0-7]/.test(inner[i + 1] ?? '')) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 4;
    }
    if (bytes.length) {
      result += Buffer.from(bytes).toString('utf8');
      continue;
    }
    // Other single-char escapes git may emit
    const esc = inner[i + 1];
    const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\x08' };
    result += simple[esc] ?? ('\\' + esc);
    i += 2;
  }
  return result;
}

// 解析git status --porcelain输出
function parseGitStatus(output) {
  // Only split on newlines — never trim the output. Porcelain lines start with
  // two status columns; a leading space (e.g. " M path") is significant and
  // trimming it would shift the path slice by one character.
  const lines = output.split('\n').filter(Boolean);
  return lines.map(line => {
    const status = line.substring(0, 2);
    // git quotes paths containing non-ASCII characters — decode them so that
    // the path we store matches what git and the filesystem actually expect.
    const filePath = decodeGitPath(line.substring(3));

    let statusType = 'modified';
    if (status.includes('A')) statusType = 'added';
    else if (status.includes('D')) statusType = 'deleted';
    else if (status.includes('M')) statusType = 'modified';
    else if (status.includes('?')) statusType = 'untracked';

    return { path: filePath, status: statusType };
  });
}
