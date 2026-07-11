import { useEffect, useState } from 'react';
import type { MemoryEntry } from '@shared/memory';

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
    await refresh();
  }

  async function deleteEntry(namespace: string, id: string) {
    await window.geepus.memory.forget(namespace, id);
    await refresh();
  }

  async function runConsolidate() {
    const reports = await window.geepus.memory.consolidate();
    const removed = reports.reduce((sum, r) => sum + r.duplicatesRemoved, 0);
    setStatus(`Consolidated — removed ${removed} duplicate${removed === 1 ? '' : 's'}.`);
    await refresh();
  }

  return (
    <div className="memory-browser">
      <div className="composer">
        <input
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addNote();
          }}
          placeholder="Teach Geepus something…"
        />
        <button onClick={() => void addNote()} disabled={!newNote.trim()}>
          Remember
        </button>
        <button onClick={() => void runConsolidate()}>Consolidate</button>
      </div>
      {status && <p className="hint">{status}</p>}

      <div className="memory-entries">
        {entries.length === 0 && <p className="hint">Nothing remembered yet.</p>}
        {entries.map((entry) => (
          <div key={`${entry.namespace}:${entry.id}`} className="memory-entry">
            <span className="pill">{String(entry.metadata['type'] ?? entry.namespace)}</span>
            <p>{entry.text}</p>
            <button onClick={() => void deleteEntry(entry.namespace, entry.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
