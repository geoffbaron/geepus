import { useEffect, useState } from 'react';
import type { MemoryEntry } from '@shared/memory';

/** "Things Geepus remembers" — teach it facts, see what it knows, make it forget. */
export function MemoryBrowser() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [newNote, setNewNote] = useState('');
  const [status, setStatus] = useState('');

  async function refresh() {
    setEntries(await window.geepus.memory.listEntries());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addNote() {
    const text = newNote.trim();
    if (!text) return;
    await window.geepus.memory.remember(text);
    setNewNote('');
    setStatus('Got it — remembered.');
    await refresh();
  }

  async function deleteEntry(namespace: string, id: string) {
    await window.geepus.memory.forget(namespace, id);
    await refresh();
  }

  async function tidyUp() {
    const reports = await window.geepus.memory.consolidate();
    const removed = reports.reduce((sum, r) => sum + r.duplicatesRemoved, 0);
    setStatus(removed > 0 ? `Tidied up — removed ${removed} duplicate${removed === 1 ? '' : 's'}.` : 'All tidy already.');
    await refresh();
  }

  return (
    <div className="memory-section">
      <div className="field-row">
        <input
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addNote();
          }}
          placeholder='Tell Geepus something to remember, e.g. "My sister’s birthday is March 12"'
        />
        <button className="primary" onClick={() => void addNote()} disabled={!newNote.trim()}>
          Remember
        </button>
      </div>
      {status && <p className="muted">{status}</p>}

      {entries.length === 0 && <p className="muted">Nothing here yet — anything you teach Geepus shows up here.</p>}
      {entries.map((entry) => (
        <div key={`${entry.namespace}:${entry.id}`} className="memory-entry">
          <p>{entry.text}</p>
          <button onClick={() => void deleteEntry(entry.namespace, entry.id)}>Forget</button>
        </div>
      ))}

      {entries.length > 1 && (
        <button className="subtle-action" onClick={() => void tidyUp()}>
          Tidy up duplicates
        </button>
      )}
    </div>
  );
}
