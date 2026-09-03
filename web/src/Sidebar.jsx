import React, { useState, useRef, useEffect, useMemo } from 'react';

// Collapse buttons live in localStorage under this key, so a page reload keeps
// each sidebar section either expanded or collapsed.
const SECTION_COLLAPSED_KEY = 'sidebarSectionsCollapsed';
function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(SECTION_COLLAPSED_KEY)) || {};
  } catch {
    return {};
  }
}
function saveCollapsed(state) {
  try {
    localStorage.setItem(SECTION_COLLAPSED_KEY, JSON.stringify(state));
  } catch {
    /* storage full/unavailable — collapsing just won't persist */
  }
}

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
    const title = draft.replace(/\s+/g, ' ').trim();
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
            onChange={(e) => {
              const cleaned = e.target.value.replace(/\s+/g, ' ');
              setDraft(cleaned);
            }}
            onCompositionEnd={(e) => {
              const cleaned = e.target.value.replace(/\s+/g, ' ');
              setDraft(cleaned);
            }}
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

// Section header with a collapse toggle. Both the sessions and recent-sessions
// sections use it; the collapsed state persists in localStorage.
function CollapsibleHead({ title, label, count, collapsed, onToggle }) {
  return (
    <div className="side-head">
      <span className="side-head-title">
        <button
          className={`collapse-btn${collapsed ? ' collapsed' : ''}`}
          title={collapsed ? `展开${label}` : `收起${label}`}
          onClick={onToggle}
        >
          ▾
        </button>
        {title}
      </span>
      {!collapsed && <span className="count">{count}</span>}
    </div>
  );
}

// "3 分钟前"-style relative time for the recent list.
function relativeTime(ts, now) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

// One-line row for the recent list: a quick-jump entry, not the management
// row (stop / rename / cwd live in the Sessions list above).
function RecentRow({ session, active, now, onOpen }) {
  return (
    <div
      className={`recent-row${active ? ' active' : ''}`}
      onClick={() => onOpen(session.id)}
      title={`${session.title}\n${session.cwd}`}
    >
      <span className={`dot ${session.status}`} />
      <span className="recent-title">{session.title}</span>
      <span className={`kind-badge ${session.kind}`}>{KIND_LABEL[session.kind] || session.kind}</span>
      <span className="recent-time">{relativeTime(session.lastActivity, now)}</span>
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

  // Collapsed state per section, persisted. Two sections today; the keys are
  // plain strings so more can be added later without a migration.
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleSection = (key) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveCollapsed(next);
      return next;
    });
  };

  // "最近会话": most recently used across all agent kinds, newest first.
  // `lastActivity` is bumped by the server on both agent output and user
  // interaction (attach/keystroke/resize), so switching to a session to read
  // it ranks it even when the agent is silent.
  const RECENT_LIMIT = 5;
  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).slice(0, RECENT_LIMIT),
    [sessions]
  );
  // Relative times ("3 分钟前") need a clock; tick every 30s while the recent
  // list is showing so an idle dashboard doesn't say "刚刚" forever.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (collapsed.recent) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [collapsed.recent, sessions]);

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
      </section>

      <section className={`side-section${collapsed.sessions ? '' : ' grow'}`}>
        <CollapsibleHead
          title="会话 Sessions"
          label="会话列表"
          count={sessions.length}
          collapsed={!!collapsed.sessions}
          onToggle={() => toggleSection('sessions')}
        />
        {!collapsed.sessions && (
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
        )}
      </section>

      {/* Recent sizes to its (capped) content while Sessions is open, and only
          takes over the flexible space once Sessions is collapsed. */}
      <section
        className={`side-section recent${
          collapsed.recent ? '' : collapsed.sessions ? ' grow' : ' fit'
        }`}
      >
        <CollapsibleHead
          title="最近会话 Recent"
          label="最近会话"
          count={recentSessions.length}
          collapsed={!!collapsed.recent}
          onToggle={() => toggleSection('recent')}
        />
        {!collapsed.recent && (
          <div className="recent-list">
            {recentSessions.map((s) => (
              <RecentRow key={s.id} session={s} active={s.id === activeId} now={now} onOpen={onOpenSession} />
            ))}
            {recentSessions.length === 0 && <div className="muted small">还没有最近使用的会话。</div>}
          </div>
        )}
      </section>

      <div className={connected ? 'sidebar-foot ok' : 'sidebar-foot bad'}>
        {connected ? '● 后端已连接' : '○ 正在重连…'}
      </div>
    </aside>
  );
}
