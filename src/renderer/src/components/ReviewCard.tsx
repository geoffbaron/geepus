import { useState } from 'react';
import type { HandoffCard } from '@shared/handoff';
import { eventTimeLabel } from '../lib/friendly';

/**
 * Renders a draft email or proposed event inline in chat, with a button that hands off
 * to the user's own default app to finish it. Geepus never sends or saves anything itself —
 * this card IS the review step (PLAN2.md N1).
 */
export function ReviewCard({ card }: { card: HandoffCard }) {
  const [status, setStatus] = useState<string | null>(null);

  if (card.kind === 'email') {
    const { to, subject, body } = card;
    async function openInMailApp() {
      setStatus('Opening your mail app…');
      const result = await window.geepus.handoff.openMailDraft({ to, subject, body });
      setStatus(
        result.copiedToClipboard
          ? 'Opened your mail app — the full draft is also on your clipboard, just in case.'
          : 'Opened your mail app with the draft ready.',
      );
    }
    return (
      <div className="card review-card">
        <div className="review-card-field">
          <span className="review-card-label">To</span>
          <span>{card.to || <em className="muted">(not specified — you can fill this in)</em>}</span>
        </div>
        <div className="review-card-field">
          <span className="review-card-label">Subject</span>
          <span>{card.subject}</span>
        </div>
        <p className="review-card-body">{card.body}</p>
        <button className="primary" onClick={() => void openInMailApp()}>
          Open in my mail app
        </button>
        {status && <p className="muted">{status}</p>}
      </div>
    );
  }

  const { icsPath } = card;
  async function openInCalendarApp() {
    setStatus('Opening your calendar app…');
    const result = await window.geepus.handoff.openCalendarFile(icsPath);
    setStatus(result.opened ? 'Opened your calendar app — just confirm to add it.' : `Couldn't open it: ${result.error}`);
  }

  return (
    <div className="card review-card">
      <div className="review-card-field">
        <span className="review-card-label">Event</span>
        <span>{card.title}</span>
      </div>
      <div className="review-card-field">
        <span className="review-card-label">When</span>
        <span>{eventTimeLabel(card.startsAt, card.endsAt)}</span>
      </div>
      {card.location && (
        <div className="review-card-field">
          <span className="review-card-label">Where</span>
          <span>{card.location}</span>
        </div>
      )}
      {card.notes && <p className="review-card-body">{card.notes}</p>}
      <button className="primary" onClick={() => void openInCalendarApp()}>
        Add to my calendar
      </button>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
