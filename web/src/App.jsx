import React, { useEffect, useState, useCallback } from 'react';
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
      wsClient.requestList();
      openSession(session.id);
    },
    [openSession]
  );

  const handleKill = useCallback(async (id) => {
    await api.killSession(id, 'SIGTERM').catch(() => {});
  }, []);

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

  return (
    <div className="app">
      <Sidebar
        personas={personas}
        sessions={sessions}
        connected={connected}
        activeId={activeId}
        onLaunchPersona={(persona) => setLaunch({ persona })}
        onQuickLaunch={(kind) => setLaunch({ kind })}
        onOpenSession={openSession}
        onKillSession={handleKill}
        onRemoveSession={handleRemove}
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
          onCloseTab={closeTab}
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
