import React, { useState } from 'react';
import { api } from './api.js';

const COLORS = ['#7c9cff', '#ff8f6b', '#5fd39b', '#f2c14e', '#c792ea', '#4dd0e1'];

export default function PersonaEditor({ persona, cliKinds, onClose, onSaved }) {
  const isNew = !persona;
  const [form, setForm] = useState({
    name: persona?.name || '',
    kind: persona?.kind || 'claude',
    model: persona?.model || '',
    agent: persona?.agent || '',
    appendSystemPrompt: persona?.appendSystemPrompt || '',
    cwd: persona?.cwd || '',
    addDirs: (persona?.addDirs || []).join('\n'),
    env: Object.entries(persona?.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    extraArgs: (persona?.extraArgs || []).join(' '),
    color: persona?.color || COLORS[0],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const parseEnv = (text) => {
    const out = {};
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf('=');
      if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1);
    }
    return out;
  };

  const save = async () => {
    setBusy(true);
    setErr('');
    const payload = {
      name: form.name || 'Untitled',
      kind: form.kind,
      model: form.model,
      agent: form.agent,
      appendSystemPrompt: form.appendSystemPrompt,
      cwd: form.cwd,
      addDirs: form.addDirs.split('\n').map((s) => s.trim()).filter(Boolean),
      env: parseEnv(form.env),
      extraArgs: form.extraArgs.trim() ? form.extraArgs.trim().split(/\s+/) : [],
      color: form.color,
    };
    try {
      if (isNew) await api.createPersona(payload);
      else await api.updatePersona(persona.id, payload);
      await onSaved();
    } catch (e) {
      setErr(String(e.message || e));
      setBusy(false);
    }
  };

  const del = async () => {
    if (!persona) return;
    setBusy(true);
    try {
      await api.deletePersona(persona.id);
      await onSaved();
    } catch (e) {
      setErr(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{isNew ? '新建角色 New Persona' : '编辑角色 Edit Persona'}</h3>

        <div className="grid2">
          <div>
            <label>名称 Name</label>
            <input value={form.name} onChange={set('name')} placeholder="安全审计员" />
          </div>
          <div>
            <label>CLI 类型</label>
            <select value={form.kind} onChange={set('kind')}>
              {cliKinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid2">
          <div>
            <label>模型 Model</label>
            <input
              value={form.model}
              onChange={set('model')}
              placeholder={form.kind === 'opencode' ? 'provider/model' : 'claude-...'}
            />
          </div>
          <div>
            <label>Agent（子代理名，可选）</label>
            <input value={form.agent} onChange={set('agent')} placeholder="reviewer" />
          </div>
        </div>

        <label>默认工作目录 Working Dir</label>
        <input value={form.cwd} onChange={set('cwd')} placeholder="/Users/you/projects/app" />

        <label>System Prompt（append，注入到默认系统提示词之后）</label>
        <textarea rows={4} value={form.appendSystemPrompt} onChange={set('appendSystemPrompt')} />

        <div className="grid2">
          <div>
            <label>额外允许目录 --add-dir（每行一个，仅 Claude）</label>
            <textarea rows={3} value={form.addDirs} onChange={set('addDirs')} placeholder="/path/a&#10;/path/b" />
          </div>
          <div>
            <label>环境变量 Env（每行 KEY=VALUE）</label>
            <textarea rows={3} value={form.env} onChange={set('env')} placeholder="ANTHROPIC_API_KEY=..." />
          </div>
        </div>

        <label>额外参数 Extra Args（空格分隔，原样传给 CLI）</label>
        <input value={form.extraArgs} onChange={set('extraArgs')} placeholder="--verbose" />

        <label>颜色标记</label>
        <div className="color-row">
          {COLORS.map((c) => (
            <button
              key={c}
              className={form.color === c ? 'swatch sel' : 'swatch'}
              style={{ background: c }}
              onClick={() => setForm((f) => ({ ...f, color: c }))}
            />
          ))}
        </div>

        {err && <div className="err">{err}</div>}

        <div className="modal-actions">
          {!isNew && (
            <button className="ghost danger" onClick={del} disabled={busy}>
              删除
            </button>
          )}
          <div className="spacer" />
          <button className="ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
