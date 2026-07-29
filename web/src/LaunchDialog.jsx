import React, { useState, useMemo, useEffect } from 'react';
import { api } from './api.js';

// Sentinel for the "type an id by hand" choice, so it can't collide with a
// real session id (which is always a UUID).
const MANUAL = '__manual__';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

  // Resume: '' means start a blank session (the default). Otherwise it's the
  // id of a stored conversation, or MANUAL while the user types one in.
  const [rawChoice, setRawChoice] = useState('');
  const [manualId, setManualId] = useState('');
  // null = the list for the current directory hasn't arrived yet. Deriving
  // "loading" from this instead of keeping a second boolean stops the two
  // from disagreeing (a separate flag can be left stuck true when an early
  // return skips clearing it).
  const [resumable, setResumable] = useState(null);
  const resumeLoading = resumable === null;

  // Only Claude Code has resumable transcripts; opencode/terminal have none.
  const canResume = effectiveKind === 'claude';

  // The directory the launch will actually run in. The backend falls back
  // persona.cwd -> $HOME when the field is blank, so querying the raw field
  // would list $HOME's history while the session starts in the persona's
  // directory — every offered id would then be for the wrong project.
  const effectiveCwd = cwd || selectedPersona?.cwd || '';

  // Reload the picker whenever the directory it's scoped to changes. Claude
  // stores transcripts per working directory, so the list is only meaningful
  // relative to that directory. Debounced because cwd is a free-text field
  // being typed into.
  useEffect(() => {
    if (!canResume) return;
    let cancelled = false;
    // Clear first: showing the previous directory's sessions while the new
    // list is in flight invites picking one that doesn't exist there.
    setResumable(null);
    const t = setTimeout(() => {
      api
        .listClaudeSessions(effectiveCwd)
        .then((list) => {
          if (!cancelled) setResumable(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          // A failed lookup is not a launch blocker — the picker falls back
          // to "no history", and manual id entry still works.
          if (!cancelled) setResumable([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [effectiveCwd, canResume]);

  // Invalidate a selection the current list no longer offers, derived during
  // render rather than corrected in an effect — an effect leaves one render
  // (and one submit opportunity) still holding the previous cwd's id.
  const resumeChoice =
    rawChoice && rawChoice !== MANUAL && Array.isArray(resumable)
      ? resumable.some((s) => s.sessionId === rawChoice)
        ? rawChoice
        : ''
      : rawChoice;

  const resumeSessionId = resumeChoice === MANUAL ? manualId.trim() : resumeChoice;
  // A hand-typed id that isn't a UUID would otherwise be rejected by the
  // server after the dialog had already closed, or — when left blank —
  // silently launch a new empty session instead of resuming anything.
  const manualIdInvalid = resumeChoice === MANUAL && !SESSION_ID_RE.test(resumeSessionId);
  // Launching mid-reload could send an id from the directory the user just
  // navigated away from.
  const resumeNotReady = canResume && rawChoice !== '' && rawChoice !== MANUAL && resumeLoading;

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
        // Blank = start a new empty conversation. Guarded by manualIdInvalid
        // on the button so a half-typed id can't quietly become "new session".
        resumeSessionId: (canResume && resumeSessionId) || undefined,
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

        {canResume && (
          <>
            <label>
              恢复会话 Resume（留空 = 新建空白会话）
              {resumeLoading && <span className="muted small"> · 读取中…</span>}
            </label>
            <select value={resumeChoice} onChange={(e) => setRawChoice(e.target.value)}>
              <option value="">（新建空白会话 / new session）</option>
              {(resumable || []).map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {formatWhen(s.mtime)} · {s.preview || '(无摘要)'}
                </option>
              ))}
              <option value={MANUAL}>（手动输入 session ID…）</option>
            </select>
            {resumeChoice === MANUAL && (
              <input
                value={manualId}
                placeholder="例如 92d24c92-b5c5-4329-aedf-d51633d1cd6e"
                onChange={(e) => setManualId(e.target.value)}
              />
            )}
            {resumeChoice === '' && !resumeLoading && resumable?.length === 0 && (
              <div className="muted small field-hint">
                {effectiveCwd ? '该目录下暂无历史会话记录' : '当前目录（$HOME）暂无历史会话记录'}
              </div>
            )}
            {manualIdInvalid && manualId.trim() !== '' && (
              <div className="muted small field-hint">session ID 格式不正确（应为 UUID）</div>
            )}
            {resumeSessionId && !manualIdInvalid && (
              <div className="muted small field-hint">
                将以 --resume --fork-session 启动：保留原记录不变，另存为新会话
              </div>
            )}
          </>
        )}

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
          <button
            className="primary"
            onClick={submit}
            disabled={busy || manualIdInvalid || resumeNotReady}
          >
            {busy ? '启动中…' : resumeNotReady ? '读取会话列表…' : '启动 →'}
          </button>
        </div>
      </div>
    </div>
  );
}
