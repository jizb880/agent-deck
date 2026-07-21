import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from './api.js';
import { wsClient } from './wsClient.js';
import Sidebar from './Sidebar.jsx';
import TerminalGrid from './TerminalGrid.jsx';
import LaunchDialog from './LaunchDialog.jsx';
import PersonaEditor from './PersonaEditor.jsx';

export default function App() {
  const [personas, setPersonas] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [cliKinds, setCliKinds] = useState([]);
  const [connected, setConnected] = useState(false);

  // openTabs: ordered session ids shown in the grid. activeId: focused tab.
  const [openTabs, setOpenTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [layout, setLayout] = useState('tabs'); // 'tabs' | 'split'

  // Client-side display order for the sidebar session list (drag to reorder).
  // The server roster is unordered from the UI's perspective; new sessions
  // are appended, vanished ones dropped.
  const [sessionOrder, setSessionOrder] = useState([]);

  const [launch, setLaunch] = useState(null); // { persona } | { kind } | true
  const [editingPersona, setEditingPersona] = useState(null); // persona | 'new' | null
  const [toast, setToast] = useState(null);

  const refreshPersonas = useCallback(async () => {
    setPersonas(await api.listPersonas());
  }, []);

  useEffect(() => {
    api.cliKinds().then(setCliKinds).catch(() => {});
    refreshPersonas().catch(() => {});
    const offRoster = wsClient.onRoster(setSessions);
    const offConn = wsClient.onConnectionChange(setConnected);
    const offErr = wsClient.onError((frame) => setToast(frame.message || 'Protocol error'));
    return () => {
      offRoster();
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
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
    setActiveId(id);
  }, []);

  const closeTab = useCallback(
    (id) => {
      setOpenTabs((tabs) => {
        const next = tabs.filter((t) => t !== id);
        setActiveId((cur) => (cur === id ? next[next.length - 1] || null : cur));
        return next;
      });
    },
    []
  );

  const handleCreate = useCallback(
    async (payload) => {
      const session = await api.createSession(payload);
      setLaunch(null);
      // Seed the roster with the POST response so the new tab renders
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

  // Sidebar「停止」and the tab's × both mean "close this terminal":
  // terminate the CLI (SIGTERM) and close its tab. The session lingers in the
  // sidebar as 已退出 (removable / auto-reaped) so final output stays readable.
  const closeSession = useCallback(
    (id) => {
      api.killSession(id, 'SIGTERM').catch(() => {});
      closeTab(id);
    },
    [closeTab]
  );

  const handleRemove = useCallback(
    async (id) => {
      await api.removeSession(id).catch(() => {});
      closeTab(id);
      wsClient.requestList();
    },
    [closeTab]
  );

  // Drop tabs whose session vanished from the roster.
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.id));
    setOpenTabs((tabs) => tabs.filter((t) => live.has(t)));
  }, [sessions]);

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

  const reorderTabs = useCallback((fromId, toId) => {
    setOpenTabs((tabs) => moveId(tabs, fromId, toId));
  }, []);

  const reorderSessions = useCallback((fromId, toId) => {
    setSessionOrder((order) => moveId(order, fromId, toId));
  }, []);

  return (
    <div className="app">
      <Sidebar
        personas={personas}
        sessions={orderedSessions}
        connected={connected}
        activeId={activeId}
        onLaunchPersona={(persona) => setLaunch({ persona })}
        onQuickLaunch={(kind) => setLaunch({ kind })}
        onQuickTerminal={handleQuickTerminal}
        onOpenSession={openSession}
        onKillSession={closeSession}
        onRemoveSession={handleRemove}
        onReorderSession={reorderSessions}
        onNewPersona={() => setEditingPersona('new')}
        onEditPersona={(p) => setEditingPersona(p)}
      />

      <main className="main">
        <div className="topbar">
          <div className="brand">Agent Control</div>
          <div className="layout-toggle">
            <button
              className={layout === 'tabs' ? 'seg active' : 'seg'}
              onClick={() => setLayout('tabs')}
            >
              标签 Tabs
            </button>
            <button
              className={layout === 'split' ? 'seg active' : 'seg'}
              onClick={() => setLayout('split')}
            >
              分屏 Split
            </button>
          </div>
          <div className={connected ? 'conn ok' : 'conn bad'}>
            {connected ? '● connected' : '○ reconnecting'}
          </div>
        </div>

        <TerminalGrid
          openTabs={openTabs}
          activeId={activeId}
          sessions={sessions}
          layout={layout}
          onActivate={setActiveId}
          onCloseTab={closeSession}
          onReorderTab={reorderTabs}
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
