import { useState, useEffect, useRef } from 'react';
import { api, getToken, setToken } from './api/client.js';

import Login from './components/Login.jsx';
import SectionsHub from './components/SectionsHub.jsx';
import Home from './components/Home.jsx';
import Diagram from './components/Diagram.jsx';
import PdfList from './components/pdfs/PdfList.jsx';
import TemplateList from './components/pdfs/TemplateList.jsx';

export default function App() {
  // views: 'login' | 'hub' | 'diagrams' | 'pdfs' | 'templates' | 'files' | 'diagram'
  const [view, setView] = useState('login');
  const [user, setUser] = useState(null);
  const [processId, setProcessId] = useState(null);
  const [focusNodeId, setFocusNodeId] = useState(null);
  const [bootChecking, setBootChecking] = useState(true);
  // A diagram id parsed from a share link (?d=<id>&n=<nodeId>), pending until
  // the user is authenticated. Kept in a ref so it survives re-renders.
  const pendingShare = useRef(null);

  // Read the share-link params once, and strip them from the URL so a refresh
  // doesn't keep forcing the same diagram open.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('d');
    if (d) {
      pendingShare.current = { id: d, nodeId: params.get('n') || null };
      const clean = window.location.pathname + window.location.hash;
      try { window.history.replaceState({}, '', clean); } catch (e) { }
    }
  }, []);

  function consumeShare() {
    const share = pendingShare.current;
    if (!share) return false;
    pendingShare.current = null;
    const id = /^\d+$/.test(share.id) ? Number(share.id) : share.id;
    openProcess(id, share.nodeId ? (/^\d+$/.test(share.nodeId) ? Number(share.nodeId) : share.nodeId) : null);
    return true;
  }

  useEffect(() => {
    (async () => {
      const token = getToken();
      if (!token) {
        setBootChecking(false);
        return;
      }
      try {
        const me = await api.me();
        setUser(me);
        localStorage.setItem('role', me.role);
        localStorage.setItem('username', me.username);
        if (!consumeShare()) setView('hub');
      } catch (e) {
        console.error(e);
        setToken(null);
        localStorage.removeItem('role');
        localStorage.removeItem('username');
      } finally {
        setBootChecking(false);
      }
    })();
    // eslint-disable-next-line
  }, []);

  function onLogin(data) {
    setUser(data);
    localStorage.setItem('role', data.role);
    localStorage.setItem('username', data.username);
    if (!consumeShare()) setView('hub');
  }

  function onLogout() {
    setToken(null);
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    setUser(null);
    setProcessId(null);
    setView('login');
  }

  function pickSection(key) {
    if (key === 'diagrams') setView('diagrams');
    else if (key === 'pdfs') setView('pdfs');
    else if (key === 'templates') setView('templates');
  }

  function openProcess(id, nodeId = null) {
    setProcessId(id);
    setFocusNodeId(nodeId);
    setView('diagram');
  }

  function backToDiagrams() {
    setProcessId(null);
    setFocusNodeId(null);
    setView('diagrams');
  }

  function backToHub() {
    setProcessId(null);
    setFocusNodeId(null);
    setView('hub');
  }

  if (bootChecking) {
    return <div className="boot-screen">Yüklənir...</div>;
  }

  if (view === 'login') {
    return <Login onLogin={onLogin} />;
  }

  if (view === 'hub') {
    return <SectionsHub onPick={pickSection} onLogout={onLogout} />;
  }

  if (view === 'diagrams') {
    return <Home onOpen={openProcess} onLogout={onLogout} onBack={backToHub} />;
  }

  if (view === 'pdfs') {
    return <PdfList onBack={backToHub} onLogout={onLogout} />;
  }

  if (view === 'templates') {
    return <TemplateList onBack={backToHub} onLogout={onLogout} />;
  }

  if (view === 'diagram') {
    return (
      <Diagram
        processId={processId}
        focusNodeId={focusNodeId}
        onBack={backToDiagrams}
        onLogout={onLogout}
        user={user}
      />
    );
  }

  return null;
}
