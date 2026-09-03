import React, { useEffect, useState, useCallback, useMemo } from 'react';

// Sidebar resize bounds (px). Width persists across reloads via localStorage.
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 300;
const clampSidebar = (w) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
import { api } from './api.js';
import { wsClient } from './wsClient.js';
import Sidebar from './Sidebar.jsx';
import RightPanel from './RightPanel.jsx';
import LaunchDialog from './LaunchDialog.jsx';
import PersonaEditor from './PersonaEditor.jsx';

export default function App() {
  const [personas, setPersonas] = useState([]);
  const [sessions, setSessions] = useState([]);
  // Persisted session history from the server — survives backend restarts.
  // The sidebar merges it with the live roster for the "Recent" list.
  const [history, setHistory] = useState([]);
  const [cliKinds, setCliKinds] = useState([]);
  const [connected, setConnected] = useState(false);

  // activeId: currently selected session
  const [activeId, setActiveId] = useState(null);
  // currentView: which view to show in right panel
  const [currentView, setCurrentView] = useState('terminal'); // 'terminal' | 'files' | 'git'

  // Client-side display order for the sidebar session list (drag to reorder).
  // The server roster is unordered from the UI's perspective; new sessions
  // are appended, vanished ones dropped.
  const [sessionOrder, setSessionOrder] = useState([]);

  const [launch, setLaunch] = useState(null); // { persona } | { kind } | true
  const [editingPersona, setEditingPersona] = useState(null); // persona | 'new' | null
  const [toast, setToast] = useState(null);

  // Sidebar width: draggable via the divider between sidebar and main pane.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('sidebarWidth'));
    return Number.isFinite(saved) && saved > 0 ? clampSidebar(saved) : SIDEBAR_DEFAULT;
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);

  const startSidebarResize = useCallback(
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      let latest = startW;
      setResizingSidebar(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const onMove = (ev) => {
        latest = clampSidebar(startW + ev.clientX - startX);
        setSidebarWidth(latest);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setResizingSidebar(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('sidebarWidth', String(latest));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [sidebarWidth]
  );

  // Double-click the divider to reset to the default width.
  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT);
    localStorage.setItem('sidebarWidth', String(SIDEBAR_DEFAULT));
  }, []);

  const refreshPersonas = useCallback(async () => {
    setPersonas(await api.listPersonas());
  }, []);

  useEffect(() => {
    api.cliKinds().then(setCliKinds).catch(() => {});
    refreshPersonas().catch(() => {});
    const offRoster = wsClient.onRoster(setSessions);
    const offHistory = wsClient.onHistory(setHistory);
    const offConn = wsClient.onConnectionChange(setConnected);
    const offErr = wsClient.onError((frame) => setToast(frame.message || 'Protocol error'));
    return () => {
      offRoster();
      offHistory();
      offConn();
      offErr();
    };
  }, [refreshPersonas]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const openSession = useCallback((id) => {
    setActiveId(id);
    // Switch to terminal view when opening a session
    setCurrentView('terminal');
  }, []);

  const handleCreate = useCallback(
    async (payload) => {
      const session = await api.createSession(payload);
      setLaunch(null);
      // Seed the roster with the POST response so the session appears
      // immediately instead of waiting on (or racing) the WS broadcast;
      // the next roster frame reconciles authoritative state.
      setSessions((prev) =>
        prev.some((s) => s.id === session.id) ? prev : [...prev, session]
      );
      wsClient.requestList();
      openSession(session.id);
    },
    [openSession]
  );

  // One-click plain shell terminal — no dialog, opens straight as a tab.
  const handleQuickTerminal = useCallback(async () => {
    try {
      await handleCreate({ kind: 'terminal' });
    } catch (e) {
      setToast(String(e.message || e));
    }
  }, [handleCreate]);

  // Reopen a closed entry from the Recent list. The server resumes the stored
  // Claude conversation in place, or relaunches other kinds with the same
  // settings; if the transcript is gone it starts fresh and tells us.
  const handleReopen = useCallback(
    async (id) => {
      try {
        const { session, resumed } = await api.reopenSessionHistory(id);
        setSessions((prev) =>
          prev.some((s) => s.id === session.id) ? prev : [...prev, session]
        );
        wsClient.requestList();
        openSession(session.id);
        if (session.kind === 'claude' && resumed === false) {
          setToast('历史对话记录已不存在，已新建会话');
        }
      } catch (e) {
        setToast(String(e.message || e));
      }
    },
    [openSession]
  );

  const handleRemoveHistory = useCallback((id) => {
    // Optimistic: the server broadcasts the authoritative list right after.
    setHistory((prev) => prev.filter((e) => e.id !== id));
    api.removeSessionHistory(id).catch((e) => setToast(String(e.message || e)));
  }, []);

  // Sidebar「停止」: terminate the CLI (SIGTERM). The session
  // lingers in the sidebar as 已退出 (removable / auto-reaped) so final output
  // stays readable.
  const closeSession = useCallback((id) => {
    api.killSession(id, 'SIGTERM').catch(() => {});
    // If this was the active session, clear it
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  const handleRemove = useCallback(async (id) => {
    await api.removeSession(id).catch(() => {});
    setActiveId((cur) => (cur === id ? null : cur));
    wsClient.requestList();
  }, []);

  // Rename a session: optimistic local update, then persist; the WS roster
  // broadcast reconciles authoritative state for every client (sidebar + tabs).
  const handleRename = useCallback((id, title) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    api.renameSession(id, title).catch((e) => {
      setToast(String(e.message || e));
      wsClient.requestList(); // roll back to server state
    });
  }, []);

  // Clear active session if it vanished from the roster.
  useEffect(() => {
    if (activeId && !sessions.some((s) => s.id === activeId)) {
      setActiveId(null);
    }
  }, [sessions, activeId]);

  // Keep sessionOrder in sync with the roster: drop gone ids, append new ones.
  useEffect(() => {
    setSessionOrder((order) => {
      const ids = sessions.map((s) => s.id);
      const live = new Set(ids);
      const kept = order.filter((id) => live.has(id));
      const known = new Set(kept);
      for (const id of ids) if (!known.has(id)) kept.push(id);
      return kept;
    });
  }, [sessions]);

  const orderedSessions = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return sessionOrder.map((id) => byId.get(id)).filter(Boolean);
  }, [sessions, sessionOrder]);

  // Move `fromId` to `toId`'s position in an id list (drag reorder).
  const moveId = (list, fromId, toId) => {
    const from = list.indexOf(fromId);
    const to = list.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return list;
    const next = [...list];
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    return next;
  };

  const reorderSessions = useCallback((fromId, toId) => {
    setSessionOrder((order) => moveId(order, fromId, toId));
  }, []);

  return (
    <div className="app" style={{ '--sidebar-width': `${sidebarWidth}px` }}>
      <Sidebar
        personas={personas}
        sessions={orderedSessions}
        history={history}
        cliKinds={cliKinds}
        connected={connected}
        activeId={activeId}
        onLaunchPersona={(persona) => setLaunch({ persona })}
        onQuickLaunch={(kind) => setLaunch({ kind })}
        onQuickTerminal={handleQuickTerminal}
        onOpenSession={openSession}
        onReopenSession={handleReopen}
        onRemoveHistory={handleRemoveHistory}
        onKillSession={closeSession}
        onRemoveSession={handleRemove}
        onRenameSession={handleRename}
        onReorderSession={reorderSessions}
        onNewPersona={() => setEditingPersona('new')}
        onEditPersona={(p) => setEditingPersona(p)}
      />

      <div
        className={resizingSidebar ? 'sidebar-resizer active' : 'sidebar-resizer'}
        onPointerDown={startSidebarResize}
        onDoubleClick={resetSidebarWidth}
        title="拖拽调节侧栏宽度（双击复位）"
      />

      <main className="main">
        <RightPanel
          currentView={currentView}
          onViewChange={setCurrentView}
          activeSession={activeId}
          sessions={sessions}
        />
      </main>

      {launch && (
        <LaunchDialog
          initial={launch}
          personas={personas}
          cliKinds={cliKinds}
          onCancel={() => setLaunch(null)}
          onSubmit={handleCreate}
        />
      )}
      {toast && (
        <div className="toast">
          {toast}
          <button className="toast-close" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {editingPersona && (
        <PersonaEditor
          persona={editingPersona === 'new' ? null : editingPersona}
          cliKinds={cliKinds}
          onClose={() => setEditingPersona(null)}
          onSaved={async () => {
            setEditingPersona(null);
            await refreshPersonas();
          }}
        />
      )}
    </div>
  );
}
