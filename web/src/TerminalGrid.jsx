import React, { useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import TerminalView from './TerminalView.jsx';

const KIND_LABEL = { claude: 'Claude Code', opencode: 'OpenCode', terminal: 'Terminal' };

function TabHeader({ session, active, dragging, onActivate, onClose, onDragStart, onDragOver, onDragEnd }) {
  return (
    <div
      className={`tab${active ? ' active' : ''}${dragging ? ' dragging' : ''}`}
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
      onClick={() => onActivate(session.id)}
      title={session.cwd}
    >
      <span className={`dot ${session.status}`} />
      <span className="tab-title">{session.title}</span>
      <span className={`kind-badge ${session.kind}`}>{KIND_LABEL[session.kind]}</span>
      <button
        className="tab-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose(session.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

export default function TerminalGrid({
  openTabs,
  activeId,
  sessions,
  layout,
  onActivate,
  onCloseTab,
  onReorderTab,
}) {
  // Live drag reorder: while a tab is dragged over a sibling, swap immediately.
  const [dragId, setDragId] = useState(null);
  const handleDragOver = (overId) => {
    if (dragId && dragId !== overId) onReorderTab(dragId, overId);
  };

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const tabs = openTabs.filter((id) => byId.has(id));

  if (tabs.length === 0) {
    return (
      <div className="grid empty">
        <div className="empty-hint">
          <h2>没有打开的会话</h2>
          <p>从左侧边栏点击一个 Persona 的「以此身份启动」，或用快捷启动开一个新的 CLI 会话。</p>
          <p className="muted">Pick a persona on the left to launch a Claude Code or OpenCode session.</p>
        </div>
      </div>
    );
  }

  // SPLIT: tile every open terminal in a resizable grid, all mounted & live.
  if (layout === 'split') {
    return (
      <div className="grid">
        <PanelGroup direction="horizontal" className="split-root">
          {tabs.map((id, i) => (
            <React.Fragment key={id}>
              {i > 0 && <PanelResizeHandle className="resize-handle" />}
              <Panel minSize={15}>
                <div className="pane">
                  <div className="pane-head">
                    <span className={`dot ${byId.get(id).status}`} />
                    <span className="pane-title">{byId.get(id).title}</span>
                    <span className={`kind-badge ${byId.get(id).kind}`}>
                      {KIND_LABEL[byId.get(id).kind]}
                    </span>
                    <button className="tab-close" onClick={() => onCloseTab(id)}>
                      ×
                    </button>
                  </div>
                  <div className="pane-body" onMouseDown={() => onActivate(id)}>
                    <TerminalView sessionId={id} active={id === activeId} />
                  </div>
                </div>
              </Panel>
            </React.Fragment>
          ))}
        </PanelGroup>
      </div>
    );
  }

  // TABS: all terminals stay mounted (keep PTY streams live); hide inactive.
  return (
    <div className="grid">
      <div className="tabstrip">
        {tabs.map((id) => (
          <TabHeader
            key={id}
            session={byId.get(id)}
            active={id === activeId}
            dragging={id === dragId}
            onActivate={onActivate}
            onClose={onCloseTab}
            onDragStart={setDragId}
            onDragOver={handleDragOver}
            onDragEnd={() => setDragId(null)}
          />
        ))}
      </div>
      <div className="tab-panes">
        {tabs.map((id) => (
          <div
            key={id}
            className="tab-pane"
            style={{ display: id === activeId ? 'block' : 'none' }}
          >
            <TerminalView sessionId={id} active={id === activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}
