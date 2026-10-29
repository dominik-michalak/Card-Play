import {
  TICKET_BODY_MAX,
  TICKET_SUBJECT_MAX,
  type TicketDetail,
  type TicketStatus,
  type TicketSummary,
} from '@cardplay/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api } from './api';
import { formatDate } from './labels';

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'otwarte',
  in_progress: 'w toku',
  resolved: 'rozwiązane',
  closed: 'zamknięte',
};

export function TicketsView({ api }: { api: Api }) {
  const [list, setList] = useState<TicketSummary[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fail = (e: unknown, fallback: string) =>
    setMessage(e instanceof ApiError ? e.message : fallback);

  const reload = useCallback(
    () =>
      api.tickets({ limit: 100 }).then(
        (page) => setList(page.items),
        (e: unknown) =>
          setMessage(e instanceof ApiError ? e.message : 'Nie udało się pobrać zgłoszeń'),
      ),
    [api],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  async function open(id: string) {
    setMessage(null);
    try {
      setSelected(await api.ticket(id));
    } catch (e) {
      fail(e, 'Nie udało się pobrać zgłoszenia');
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setMessage(null);
    try {
      const created = await api.createTicket({
        subject: String(data.get('subject')),
        body: String(data.get('body')),
      });
      form.reset();
      setSelected(created);
      await reload();
    } catch (e) {
      fail(e, 'Nie udało się wysłać zgłoszenia');
    }
  }

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    setMessage(null);
    try {
      setSelected(await api.replyToTicket(selected.id, String(new FormData(form).get('body'))));
      form.reset();
      await reload();
    } catch (e) {
      fail(e, 'Nie udało się wysłać odpowiedzi');
    }
  }

  return (
    <div>
      <h2>Zgłoszenia</h2>
      {message && <p role="alert">{message}</p>}

      {selected ? (
        <div>
          <button onClick={() => setSelected(null)}>Wróć do listy</button>
          <h3>{selected.subject}</h3>
          <p>
            Status: {STATUS_LABELS[selected.status]}, utworzone: {formatDate(selected.createdAt)}
          </p>
          {/* user text is shown as plain text: React escapes it */}
          <p style={{ whiteSpace: 'pre-wrap' }}>{selected.body}</p>
          <h4>Odpowiedzi</h4>
          {selected.replies.length === 0 && <p>Brak odpowiedzi.</p>}
          {selected.replies.map((r) => (
            <div key={r.id}>
              <strong>{r.authorName}</strong> ({formatDate(r.createdAt)})
              <p style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>
            </div>
          ))}
          {selected.status !== 'closed' ? (
            <form onSubmit={(e) => void reply(e)}>
              <label>
                Twoja odpowiedź
                <textarea name="body" required maxLength={TICKET_BODY_MAX} rows={4} />
              </label>
              <button type="submit">Wyślij</button>
            </form>
          ) : (
            <p>Zgłoszenie jest zamknięte.</p>
          )}
        </div>
      ) : (
        <>
          <form onSubmit={(e) => void create(e)}>
            <h3>Nowe zgłoszenie</h3>
            <label>
              Temat
              <input name="subject" required maxLength={TICKET_SUBJECT_MAX} autoComplete="off" />
            </label>
            <label>
              Opis
              <textarea name="body" required maxLength={TICKET_BODY_MAX} rows={5} />
            </label>
            <button type="submit">Wyślij zgłoszenie</button>
          </form>
          <h3>Twoje zgłoszenia</h3>
          {list.length === 0 ? (
            <p>Nie masz jeszcze zgłoszeń.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Temat</th>
                  <th>Status</th>
                  <th>Ostatnia zmiana</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button onClick={() => void open(t.id)}>{t.subject}</button>
                    </td>
                    <td>{STATUS_LABELS[t.status]}</td>
                    <td>{formatDate(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
