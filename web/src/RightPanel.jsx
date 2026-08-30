import React from 'react';
import TerminalView from './TerminalView.jsx';
import FileExplorer from './FileExplorer.jsx';
import GitDiffViewer from './GitDiffViewer.jsx';

// 视图切换按钮
function ViewSwitcher({ currentView, onViewChange }) {
  const views = [
    { id: 'terminal', label: '终端 Terminal', icon: '⌨️' },
    { id: 'files', label: '文件 Files', icon: '📁' },
    { id: 'git', label: 'Git', icon: '🔀' },
  ];

  return (
    <div className="view-switcher">
      {views.map(view => (
        <button
          key={view.id}
          className={currentView === view.id ? 'view-btn active' : 'view-btn'}
          onClick={() => onViewChange(view.id)}
        >
          <span className="view-icon">{view.icon}</span>
          <span className="view-label">{view.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function RightPanel({
  currentView,
  onViewChange,
  activeSession,
  sessions,
}) {
  const session = sessions.find(s => s.id === activeSession);
  const cwd = session?.cwd;

  return (
    <div className="right-panel">
      <div className="right-panel-header">
        <ViewSwitcher currentView={currentView} onViewChange={onViewChange} />
        {session && (
          <div className="session-info">
            <span className={`dot ${session.status}`} />
            <span className="session-title">{session.title}</span>
            <span className={`kind-badge ${session.kind}`}>
              {session.kind === 'claude' ? 'Claude Code' :
               session.kind === 'opencode' ? 'OpenCode' :
               session.kind === 'terminal' ? 'Terminal' : session.kind}
            </span>
          </div>
        )}
      </div>

      <div className="right-panel-content">
        {!session ? (
          <div className="empty-state">
            <h2>没有选择会话</h2>
            <p className="muted">从左侧边栏选择一个会话以查看内容</p>
          </div>
        ) : (
          <>
            {currentView === 'terminal' && (
              <div className="terminal-container">
                <TerminalView sessionId={activeSession} active={true} kind={session.kind} />
              </div>
            )}
            {currentView === 'files' && (
              <FileExplorer cwd={cwd} />
            )}
            {currentView === 'git' && (
              <GitDiffViewer cwd={cwd} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
