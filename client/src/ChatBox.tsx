import { useEffect, useRef, type FormEvent } from 'react';
import type { ChatLine } from './room-state';

const MAX_LENGTH = 300;

type Props = { lines: ChatLine[]; onSend: (message: string) => void };

// plain text only: React shows the lines as text, so markup in a message is never run
export function ChatBox({ lines, onSend }: Props) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [lines.length]);

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = String(new FormData(form).get('message')).trim();
    if (!message) return;
    onSend(message);
    form.reset();
  }

  return (
    <section aria-label="Czat pokoju">
      <h4>Czat</h4>
      <div role="log" aria-live="polite" style={{ maxHeight: '10rem', overflowY: 'auto' }}>
        {lines.length === 0 && <p>Brak wiadomości.</p>}
        {lines.map((line, i) => (
          <p key={`${line.sentAt}-${i}`}>
            <strong>{line.username}:</strong> {line.message}
          </p>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={send}>
        <label>
          Wiadomość
          <input name="message" maxLength={MAX_LENGTH} autoComplete="off" />
        </label>
        <button type="submit">Wyślij</button>
      </form>
    </section>
  );
}
