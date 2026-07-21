import React, { useState } from 'react';

const KIND_LABEL = { claude: 'Claude Code', opencode: 'OpenCode', terminal: 'Terminal' };
const STATUS_LABEL = {
  starting: '启动中',
  running: '运行中',
  busy: '处理中',
  idle: '空闲',
  exited: '已退出',
};

function SessionRow({
  session,
  active,
  dragging,
  onOpen,
  onKill,
  onRemove,
  onDragStart,
  onDragOver,
  onDragEnd,
}) {
  return (
    <div
      className={`sess-row${active ? ' active' : ''}${dragging ? ' dragging' : ''}`}
      draggable
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
        <div className="sess-title">{session.title}</div>
        <div className="sess-sub">
          <span className={`kind-badge ${session.kind}`}>{KIND_LABEL[session.kind]}</span>
          <span className="status-text">{STATUS_LABEL[session.status] || session.status}</span>
        </div>
        <div className="sess-cwd" title={session.cwd}>
          {session.cwd}
        </div>
      </div>
      <div className="sess-actions" onClick={(e) => e.stopPropagation()}>
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
  connected,
  activeId,
  onLaunchPersona,
  onQuickLaunch,
  onQuickTerminal,
  onOpenSession,
  onKillSession,
  onRemoveSession,
  onReorderSession,
  onNewPersona,
  onEditPersona,
}) {
  // Live drag reorder for the session list.
  const [dragId, setDragId] = useState(null);
  const handleDragOver = (overId) => {
    if (dragId && dragId !== overId) onReorderSession(dragId, overId);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">⌘ Agent Control</div>
        <div className="sub">Claude Code · OpenCode</div>
      </div>

      <section className="side-section">
        <div className="side-head">
          <span>快捷启动 Quick Launch</span>
          <button className="mini" title="新建角色" onClick={onNewPersona}>
            + 角色
          </button>
        </div>
        <div className="quick-launch">
          <button className="ql claude" onClick={() => onQuickLaunch('claude')}>
            + Claude Code
          </button>
          <button className="ql opencode" onClick={() => onQuickLaunch('opencode')}>
            + OpenCode
          </button>
          <button className="ql terminal" title="打开一个本机 shell 终端页签" onClick={onQuickTerminal}>
            + 终端
          </button>
        </div>
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
