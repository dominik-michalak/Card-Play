import {
  ADMIN_MAX_BAN_HOURS,
  BAN_REASON_MAX,
  MODERATOR_MAX_BAN_HOURS,
  TICKET_BODY_MAX,
  TICKET_STATUSES,
  USER_ROLES,
  type AuditEntry,
  type ManagedUser,
  type ManagedUserDetail,
  type TicketDetail,
  type TicketStatus,
  type TicketSummary,
  type UserRole,
} from '@cardplay/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api, type SessionUser } from './api';
import { formatDate } from './labels';

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'otwarte',
  in_progress: 'w toku',
  resolved: 'rozwiązane',
  closed: 'zamknięte',
};
const ROLE_LABELS: Record<UserRole, string> = {
  user: 'użytkownik',
  moderator: 'moderator',
  admin: 'administrator',
};

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

type Tab = 'tickets' | 'users' | 'audit';

// The panel is only a convenience: the server decides who may do what, on every request.
export function StaffView({ api, user }: { api: Api; user: SessionUser }) {
  const [tab, setTab] = useState<Tab>('tickets');
  const admin = user.role === 'admin';
  return (
    <div>
      <h2>Obsługa</h2>
      <nav>
        <button onClick={() => setTab('tickets')} aria-pressed={tab === 'tickets'}>
          Zgłoszenia
        </button>{' '}
        <button onClick={() => setTab('users')} aria-pressed={tab === 'users'}>
          Użytkownicy
        </button>{' '}
        {admin && (
          <button onClick={() => setTab('audit')} aria-pressed={tab === 'audit'}>
            Dziennik zdarzeń
          </button>
        )}
      </nav>
      {tab === 'tickets' && <StaffTickets api={api} />}
      {tab === 'users' && <StaffUsers api={api} me={user} />}
      {tab === 'audit' && admin && <StaffAudit api={api} />}
    </div>
  );
}

function StaffTickets({ api }: { api: Api }) {
  const [status, setStatus] = useState<TicketStatus | ''>('open');
  const [list, setList] = useState<TicketSummary[]>([]);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api.staffTickets({ status: status || undefined, limit: 100 }).then(
        (page) => setList(page.items),
        (e: unknown) => setMessage(errorText(e, 'Nie udało się pobrać zgłoszeń')),
      ),
    [api, status],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<TicketDetail>) {
    setMessage(null);
    try {
      setSelected(await action());
      await reload();
    } catch (e) {
      setMessage(errorText(e, 'Nie udało się wykonać akcji'));
    }
  }

  function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!selected) return;
    void run(() => api.staffReply(selected.id, String(new FormData(form).get('body')))).then(() =>
      form.reset(),
    );
  }

  return (
    <div>
      {message && <p role="alert">{message}</p>}
      {selected ? (
        <div>
          <button onClick={() => setSelected(null)}>Wróć do listy</button>
          <h3>{selected.subject}</h3>
          <p>
            Autor: {selected.author?.username}, status: {STATUS_LABELS[selected.status]}, utworzone:{' '}
            {formatDate(selected.createdAt)}
          </p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{selected.body}</p>
          <label>
            Status
            <select
              value={selected.status}
              onChange={(e) =>
                void run(() => api.staffSetStatus(selected.id, e.target.value as TicketStatus))
              }
            >
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <h4>Odpowiedzi</h4>
          {selected.replies.length === 0 && <p>Brak odpowiedzi.</p>}
          {selected.replies.map((r) => (
            <div key={r.id}>
              <strong>
                {r.authorName}
                {r.isStaff ? ' (obsługa)' : ''}
              </strong>{' '}
              ({formatDate(r.createdAt)})<p style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>
            </div>
          ))}
          {selected.status !== 'closed' && (
            <form onSubmit={reply}>
              <label>
                Odpowiedź
                <textarea name="body" required maxLength={TICKET_BODY_MAX} rows={4} />
              </label>
              <button type="submit">Wyślij</button>
            </form>
          )}
        </div>
      ) : (
        <>
          <label>
            Pokaż
            <select value={status} onChange={(e) => setStatus(e.target.value as TicketStatus | '')}>
              <option value="">wszystkie</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          {list.length === 0 ? (
            <p>Brak zgłoszeń.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Autor</th>
                  <th>Temat</th>
                  <th>Status</th>
                  <th>Ostatnia zmiana</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td>{t.author?.username}</td>
                    <td>
                      <button onClick={() => void run(() => api.staffTicket(t.id))}>
                        {t.subject}
                      </button>
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

function banText(u: ManagedUser): string {
  if (!u.ban.active) return '';
  return u.ban.permanent ? 'zbanowany na stałe' : `zbanowany do ${formatDate(u.ban.until!)}`;
}

function StaffUsers({ api, me }: { api: Api; me: SessionUser }) {
  const [search, setSearch] = useState('');
  const [onlyBanned, setOnlyBanned] = useState(false);
  const [items, setItems] = useState<ManagedUser[]>([]);
  const [selected, setSelected] = useState<ManagedUserDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const admin = me.role === 'admin';
  const maxHours = admin ? ADMIN_MAX_BAN_HOURS : MODERATOR_MAX_BAN_HOURS;

  const reload = useCallback(
    () =>
      api.manageUsers({ search: search || undefined, banned: onlyBanned, limit: 50 }).then(
        (page) => setItems(page.items),
        (e: unknown) => setMessage(errorText(e, 'Nie udało się pobrać użytkowników')),
      ),
    [api, search, onlyBanned],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  async function open(id: string) {
    setMessage(null);
    try {
      setSelected(await api.managedUser(id));
    } catch (e) {
      setMessage(errorText(e, 'Nie udało się pobrać użytkownika'));
    }
  }

  async function run(action: () => Promise<unknown>, reopen: string, done: string) {
    setMessage(null);
    try {
      await action();
      await open(reopen);
      await reload();
      setMessage(done);
    } catch (e) {
      setMessage(errorText(e, 'Nie udało się wykonać akcji'));
    }
  }

  function ban(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const reason = String(data.get('reason'));
    const permanent = data.get('permanent') === 'on';
    void run(
      () =>
        permanent
          ? api.banUser(selected.id, { permanent: true, reason })
          : api.banUser(selected.id, { durationHours: Number(data.get('hours')), reason }),
      selected.id,
      'Użytkownik zbanowany',
    );
  }

  return (
    <div>
      {message && <p role="alert">{message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(String(new FormData(e.currentTarget).get('search')).trim());
        }}
      >
        <label>
          Szukaj po nazwie
          <input name="search" maxLength={64} autoComplete="off" />
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyBanned}
            onChange={(e) => setOnlyBanned(e.target.checked)}
          />{' '}
          tylko zbanowani
        </label>
        <button type="submit">Szukaj</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Użytkownik</th>
            <th>Rola</th>
            <th>Ban</th>
          </tr>
        </thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.id}>
              <td>
                <button onClick={() => void open(u.id)}>{u.username}</button>
              </td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td>{banText(u)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div>
          <h3>{selected.username}</h3>
          <p>
            Rola: {ROLE_LABELS[selected.role]}, konto od {formatDate(selected.createdAt)}{' '}
            {banText(selected)}
          </p>

          {admin && selected.id !== me.id && (
            <label>
              Zmień rolę
              <select
                value={selected.role}
                onChange={(e) =>
                  void run(
                    () => api.setUserRole(selected.id, e.target.value as UserRole),
                    selected.id,
                    'Rola zmieniona',
                  )
                }
              >
                {USER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          )}

          {selected.ban.active ? (
            <button
              onClick={() => void run(() => api.unbanUser(selected.id), selected.id, 'Ban zdjęty')}
              disabled={selected.ban.permanent && !admin}
            >
              Zdejmij bana
            </button>
          ) : (
            selected.id !== me.id && (
              <form onSubmit={ban}>
                <h4>Zbanuj</h4>
                <label>
                  Na ile godzin (do {maxHours})
                  <input name="hours" type="number" min={1} max={maxHours} defaultValue={24} />
                </label>
                {admin && (
                  <label>
                    <input name="permanent" type="checkbox" /> na stałe
                  </label>
                )}
                <label>
                  Powód
                  <input name="reason" required maxLength={BAN_REASON_MAX} autoComplete="off" />
                </label>
                <button type="submit">Zbanuj</button>
              </form>
            )
          )}

          <h4>Historia banów</h4>
          {selected.bans.length === 0 ? (
            <p>Brak.</p>
          ) : (
            <ul>
              {selected.bans.map((b) => (
                <li key={b.id}>
                  {formatDate(b.createdAt)}:{' '}
                  {b.permanent ? 'na stałe' : `do ${formatDate(b.expiresAt!)}`}, powód: {b.reason},
                  nałożył: {b.imposedBy ?? '—'}
                  {b.revokedAt && `, zdjęty ${formatDate(b.revokedAt)} przez ${b.revokedBy ?? '—'}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function StaffAudit({ api }: { api: Api }) {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.auditLog({ limit: 50 }).then(
      (page) => {
        setItems(page.items);
        setTotal(page.total);
      },
      (e: unknown) => setMessage(errorText(e, 'Nie udało się pobrać dziennika')),
    );
  }, [api]);

  async function more() {
    const page = await api.auditLog({ limit: 50, offset: items.length });
    setItems((current) => [...current, ...page.items]);
    setTotal(page.total);
  }

  return (
    <div>
      {message && <p role="alert">{message}</p>}
      <table>
        <thead>
          <tr>
            <th>Kiedy</th>
            <th>Kto</th>
            <th>Akcja</th>
            <th>Kogo</th>
            <th>Szczegóły</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>{formatDate(e.createdAt)}</td>
              <td>{e.actor?.username ?? '—'}</td>
              <td>{e.action}</td>
              <td>{e.target?.username ?? '—'}</td>
              <td>{JSON.stringify(e.details)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length < total && <button onClick={() => void more()}>Więcej</button>}
    </div>
  );
}
