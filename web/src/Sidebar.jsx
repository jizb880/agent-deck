import React, { useState, useRef, useEffect } from 'react';

// Fallback labels for a session whose kind is not in the server's list — e.g.
// an old session still open after that CLI was uninstalled. Live labels come
// from /api/cli-kinds; this only keeps a badge from rendering blank.
const KIND_LABEL = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  codex: 'Codex',
  terminal: 'Terminal',
};
const STATUS_LABEL = {
  starting: '启动中',
  running: '运行中',
  busy: '处理中',
  idle: '空闲',
  exited: '已退出',
};

// Copy text to the clipboard. navigator.clipboard requires a secure context
// (https/localhost); fall back to the execCommand trick for plain-http LAN use.
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function SessionRow({
  session,
  active,
  dragging,
  onOpen,
  onKill,
  onRemove,
  onRename,
  onDragStart,
  onDragOver,
  onDragEnd,
}) {
  // Inline rename: double-click the title (or hit ✎) to edit; Enter/blur
  // confirms, Esc cancels.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef(null);

  // Click the cwd line to copy the path; brief ✓ feedback.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyCwd = async (e) => {
    e.stopPropagation();
    if (await copyText(session.cwd || '')) {
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    }
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(session.title);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== session.title) onRename(session.id, title);
  };

  return (
    <div
      className={`sess-row${active ? ' active' : ''}${dragging ? ' dragging' : ''}`}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', session.id); // Firefox needs data to start a drag
        onDragStart(session.id);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(session.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(session.id)}
    >
      <span className={`dot ${session.status}`} />
      <div className="sess-meta">
        {editing ? (
          <input
            ref={inputRef}
            className="sess-rename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') setEditing(false);
            }}
            maxLength={80}
          />
        ) : (
          <div className="sess-title" title="双击重命名" onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}>
            {session.title}
          </div>
        )}
        <div className="sess-sub">
          <span className={`kind-badge ${session.kind}`}>{KIND_LABEL[session.kind]}</span>
          <span className="status-text">{STATUS_LABEL[session.status] || session.status}</span>
        </div>
        <div
          className={`sess-cwd${copied ? ' copied' : ''}`}
          title={`点击复制路径\n${session.cwd}`}
          onClick={copyCwd}
        >
          {copied ? '✓ 已复制路径' : session.cwd}
        </div>
      </div>
      <div className="sess-actions" onClick={(e) => e.stopPropagation()}>
        <button className="mini" title="重命名会话" onClick={startEdit}>
          ✎
        </button>
        {session.status !== 'exited' ? (
          <button className="mini danger" title="停止进程并关闭终端页签" onClick={() => onKill(session.id)}>
            停止
          </button>
        ) : (
          <button className="mini" title="从列表移除" onClick={() => onRemove(session.id)}>
            移除
          </button>
        )}
      </div>
    </div>
  );
}

export default function Sidebar({
  personas,
  sessions,
  cliKinds,
  connected,
  activeId,
  onLaunchPersona,
  onQuickLaunch,
  onQuickTerminal,
  onOpenSession,
  onKillSession,
  onRemoveSession,
  onRenameSession,
  onReorderSession,
  onNewPersona,
  onEditPersona,
}) {
  // Installed agent CLIs, in registry order. `terminal` is always available
  // and gets its own button, so it's filtered out of the generated set.
  const agentKinds = (cliKinds || []).filter((k) => k.id !== 'terminal' && k.available);

  // Live drag reorder for the session list.
  const [dragId, setDragId] = useState(null);
  const handleDragOver = (overId) => {
    if (dragId && dragId !== overId) onReorderSession(dragId, overId);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">▚ Agent Deck</div>
        {/* Names the CLIs actually present, so the header doesn't advertise
            tools this machine doesn't have. */}
        <div className="sub">{agentKinds.map((k) => k.label).join(' · ') || 'No agent CLI found'}</div>
      </div>

      <section className="side-section">
        <div className="side-head">
          <span>快捷启动 Quick Launch</span>
          <button className="mini" title="新建角色" onClick={onNewPersona}>
            + 角色
          </button>
        </div>
        <div className="quick-launch">
          {/* One button per agent CLI actually installed on this machine. An
              absent CLI gets no button at all rather than one that could only
              fail at spawn time. `terminal` is excluded here because it isn't
              an agent CLI — it spawns the user's own shell below. */}
          {agentKinds.map((k) => (
            <button
              key={k.id}
              className={`ql ${k.id}`}
              title={`启动 ${k.label}${k.path ? `\n${k.path}` : ''}`}
              onClick={() => onQuickLaunch(k.id)}
            >
              + {k.label}
            </button>
          ))}
          <button className="ql terminal" title="打开一个本机 shell 终端页签" onClick={onQuickTerminal}>
            + 终端
          </button>
        </div>
        {cliKinds.length > 0 && agentKinds.length === 0 && (
          <div className="muted small field-hint">
            未检测到已安装的 Agent CLI（claude / opencode / openclaw / hermes / codex）。
            安装并确保其在 PATH 中，然后刷新页面。
          </div>
        )}
        {personas.length > 0 && (
          <div className="persona-chips">
            {personas.map((p) => (
              <div className="persona-chip" key={p.id} style={{ borderLeftColor: p.color }}>
                <button
                  className="persona-chip-launch"
                  title={`以「${p.name}」启动（${KIND_LABEL[p.kind]}${p.model ? ` · ${p.model}` : ''}）`}
                  onClick={() => onLaunchPersona(p)}
                >
                  {p.name}
                </button>
                <button className="icon-btn" title="编辑角色" onClick={() => onEditPersona(p)}>
                  ✎
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="side-section grow">
        <div className="side-head">
          <span>会话 Sessions</span>
          <span className="count">{sessions.length}</span>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              dragging={s.id === dragId}
              onOpen={onOpenSession}
              onKill={onKillSession}
              onRemove={onRemoveSession}
              onRename={onRenameSession}
              onDragStart={setDragId}
              onDragOver={handleDragOver}
              onDragEnd={() => setDragId(null)}
            />
          ))}
          {sessions.length === 0 && <div className="muted small">没有运行中的会话。</div>}
        </div>
      </section>

      <div className={connected ? 'sidebar-foot ok' : 'sidebar-foot bad'}>
        {connected ? '● 后端已连接' : '○ 正在重连…'}
      </div>
    </aside>
  );
}
