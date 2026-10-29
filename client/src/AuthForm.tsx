import { useState, type FormEvent } from 'react';
import { ApiError, type Api, type SessionUser } from './api';

type Props = { api: Api; onSignedIn: (user: SessionUser) => void };

export function AuthForm({ api, onSignedIn }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === 'login'
          ? await api.login({ email, password })
          : await api.register({ username: String(form.get('username')), email, password });
      onSignedIn(user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nie udało się połączyć z serwerem');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>{mode === 'login' ? 'Logowanie' : 'Rejestracja'}</h2>
      {mode === 'register' && (
        <label>
          Nazwa użytkownika
          <input name="username" required minLength={3} maxLength={20} autoComplete="username" />
        </label>
      )}
      <label>
        E-mail
        <input name="email" type="email" required autoComplete="email" />
      </label>
      <label>
        Hasło
        <input
          name="password"
          type="password"
          required
          minLength={mode === 'register' ? 8 : 1}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>
        {mode === 'login' ? 'Zaloguj' : 'Zarejestruj'}
      </button>{' '}
      <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Załóż konto' : 'Mam już konto'}
      </button>
    </form>
  );
}
