import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, PERSONAS_FILE } from './config.js';

const DEFAULT_PERSONAS = [
  {
    id: 'refactor-expert',
    name: '重构专家 (Refactor Expert)',
    kind: 'claude',
    model: '',
    agent: '',
    appendSystemPrompt:
      'You are a senior refactoring specialist. Prioritize small, safe, behavior-preserving changes. Always explain the risk of each change and run tests after modifying code.',
    cwd: '',
    addDirs: [],
    env: {},
    extraArgs: [],
    color: '#7c9cff',
  },
  {
    id: 'dev-expert',
    name: '开发专家 (Dev Expert)',
    kind: 'claude',
    model: '',
    agent: '',
    appendSystemPrompt:
      'You are a senior full-stack development expert. Write clean, idiomatic, well-tested code. Prefer simple, maintainable solutions; explain key design decisions briefly and verify changes by running the relevant tests or the app.',
    cwd: '',
    addDirs: [],
    env: {},
    extraArgs: [],
    color: '#ff8f6b',
  },
  {
    id: 'doc-writer',
    name: '文档撰写员 (Doc Writer)',
    kind: 'claude',
    model: '',
    agent: '',
    appendSystemPrompt:
      'You are a technical documentation writer. Produce clear, concise docs with runnable examples. Match the existing tone of the repository.',
    cwd: '',
    addDirs: [],
    env: {},
    extraArgs: [],
    color: '#5fd39b',
  },
];

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PERSONAS_FILE)) {
    fs.writeFileSync(PERSONAS_FILE, JSON.stringify(DEFAULT_PERSONAS, null, 2));
  }
}

async function readAll() {
  ensureFile();
  const raw = await fsp.readFile(PERSONAS_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Serialize writes so concurrent REST calls can't interleave and corrupt the file.
let writeChain = Promise.resolve();
async function writeAll(list) {
  const tmp = PERSONAS_FILE + '.tmp';
  writeChain = writeChain.then(async () => {
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
    await fsp.rename(tmp, PERSONAS_FILE);
  });
  return writeChain;
}

const ALLOWED = [
  'name', 'kind', 'model', 'agent', 'appendSystemPrompt',
  'cwd', 'addDirs', 'env', 'extraArgs', 'color',
];

function sanitize(input) {
  const out = {};
  for (const k of ALLOWED) if (k in input) out[k] = input[k];
  if (out.kind && out.kind !== 'claude' && out.kind !== 'opencode') {
    out.kind = 'claude';
  }
  if (out.addDirs && !Array.isArray(out.addDirs)) out.addDirs = [];
  if (out.extraArgs && !Array.isArray(out.extraArgs)) out.extraArgs = [];
  if (out.env && (typeof out.env !== 'object' || Array.isArray(out.env))) out.env = {};
  return out;
}

export const personaStore = {
  async list() {
    return readAll();
  },
  async get(id) {
    return (await readAll()).find((p) => p.id === id) || null;
  },
  async create(input) {
    const list = await readAll();
    const persona = {
      id: crypto.randomUUID(),
      name: 'Untitled',
      kind: 'claude',
      model: '',
      agent: '',
      appendSystemPrompt: '',
      cwd: '',
      addDirs: [],
      env: {},
      extraArgs: [],
      color: '#7c9cff',
      ...sanitize(input),
    };
    list.push(persona);
    await writeAll(list);
    return persona;
  },
  async update(id, input) {
    const list = await readAll();
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...sanitize(input), id };
    await writeAll(list);
    return list[idx];
  },
  async remove(id) {
    const list = await readAll();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    await writeAll(next);
    return true;
  },
};

export { DEFAULT_PERSONAS };
