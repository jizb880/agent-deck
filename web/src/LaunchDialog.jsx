import React, { useState, useMemo } from 'react';

/**
 * Launch dialog: pick a persona (or bare CLI kind), then optionally override
 * working dir / model / title before spawning. Overrides win over persona
 * defaults; blank fields fall back to the persona.
 */
export default function LaunchDialog({ initial, personas, cliKinds, onCancel, onSubmit }) {
  const initialPersona = initial.persona || null;
  const [personaId, setPersonaId] = useState(initialPersona ? initialPersona.id : '');
  const [kind, setKind] = useState(
    initialPersona ? initialPersona.kind : initial.kind || 'claude'
  );

  const selectedPersona = useMemo(
    () => personas.find((p) => p.id === personaId) || null,
    [personas, personaId]
  );

  const [cwd, setCwd] = useState(initialPersona?.cwd || '');
  const [model, setModel] = useState(initialPersona?.model || '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const effectiveKind = selectedPersona ? selectedPersona.kind : kind;

  const onPersonaChange = (id) => {
    setPersonaId(id);
    const p = personas.find((x) => x.id === id);
    if (p) {
      setKind(p.kind);
      setCwd(p.cwd || '');
      setModel(p.model || '');
    }
  };

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await onSubmit({
        personaId: personaId || undefined,
        kind: personaId ? undefined : kind,
        cwd: cwd || undefined,
        model: model || undefined,
        title: title || undefined,
      });
    } catch (e) {
      setErr(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>启动新会话 Launch Session</h3>

        <label>角色 Persona</label>
        <select value={personaId} onChange={(e) => onPersonaChange(e.target.value)}>
          <option value="">（不使用角色 / bare CLI）</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {!personaId && (
          <>
            <label>CLI 类型</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {cliKinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </>
        )}

        <label>工作目录 Working Dir（留空则用角色默认 / $HOME）</label>
        <input
          value={cwd}
          placeholder="/Users/you/projects/my-app"
          onChange={(e) => setCwd(e.target.value)}
        />

        <label>模型 Model（可选覆盖）</label>
        <input
          value={model}
          placeholder={effectiveKind === 'opencode' ? 'provider/model' : 'claude-...'}
          onChange={(e) => setModel(e.target.value)}
        />

        <label>标签 Title（可选）</label>
        <input value={title} placeholder="自定义会话名" onChange={(e) => setTitle(e.target.value)} />

        {selectedPersona?.appendSystemPrompt && (
          <div className="prompt-preview">
            <div className="muted small">System Prompt (append):</div>
            <div className="prompt-text">{selectedPersona.appendSystemPrompt}</div>
          </div>
        )}

        {err && <div className="err">{err}</div>}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? '启动中…' : '启动 →'}
          </button>
        </div>
      </div>
    </div>
  );
}
