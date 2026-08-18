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

// 解析git status --porcelain输出
function parseGitStatus(output) {
  // Only trim the trailing newline: porcelain lines start with the two status
  // columns, and a leading space (e.g. " M path") is significant — trimming it
  // would shift the path slice by one character.
  const lines = output.split('\n').filter(Boolean);
  return lines.map(line => {
    const status = line.substring(0, 2);
    const filePath = line.substring(3);

    let statusType = 'modified';
    if (status.includes('A')) statusType = 'added';
    else if (status.includes('D')) statusType = 'deleted';
    else if (status.includes('M')) statusType = 'modified';
    else if (status.includes('?')) statusType = 'untracked';

    return { path: filePath, status: statusType };
  });
}
