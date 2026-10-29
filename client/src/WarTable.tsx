import type { ClientWarState } from '@cardplay/shared';
import type { CSSProperties } from 'react';
import { useCountdown } from './hooks';
import { Deck, PlayingCard } from './CardView';
import { Felt, Hud, Seat, Tag } from './TableParts';

type Props = { state: ClientWarState; meId: string; onFlip: () => void };

export function WarTable({ state, meId, onFlip }: Props) {
  const secondsLeft = useCountdown(state.turnDeadlineAt);
  const iFlipped = state.flippedPlayerIds.includes(meId);
  const names = new Map(state.players.map((p) => [p.id, p.username]));
  const me = state.players.find((p) => p.id === meId);
  const others = state.players.filter((p) => p.id !== meId);
  const last = state.lastRound;

  const seat = (p: ClientWarState['players'][number], isMe: boolean) => (
    <Seat
      key={p.id}
      name={p.username}
      me={isMe}
      badges={[state.flippedPlayerIds.includes(p.id) && 'odkryła']}
    >
      {/* each stack is shuffled once, when the game opens */}
      <Deck
        count={state.stackSizes[p.id] ?? 0}
        shuffleKey="start"
        label={`Karty w stosie ${p.username}`}
      />
    </Seat>
  );

  return (
    <div>
      <Hud
        title="Wojna"
        detail={`runda ${state.round + 1}`}
        secondsLeft={secondsLeft}
        status={
          secondsLeft === null
            ? 'Gra wstrzymana: czekamy na powrót gracza'
            : `Czas na ruch: ${secondsLeft} s`
        }
      />
      <Felt label="Stół do Wojny">
        <div className="felt__row">{others.map((p) => seat(p, false))}</div>

        <div className="felt__center war__center">
          {state.players.map((p, side) => (
            <div key={p.id} className="war__lane">
              <div className="war__pile">
                {last?.comparisons.map((pair, i) => (
                  <PlayingCard
                    key={`${state.round}-${i}`}
                    card={pair[side]}
                    size="md"
                    deal
                    from={p.id === meId ? 'bottom' : 'top'}
                    delay={i * 120}
                    rotate={((i * 7 + side * 3) % 9) - 4}
                    className={`war__card${last.winnerId === p.id && i === last.comparisons.length - 1 ? ' is-winner' : ''}`}
                    style={{ '--stack': i } as CSSProperties}
                  />
                ))}
                {state.flippedPlayerIds.includes(p.id) && (
                  <PlayingCard
                    key={`down-${state.round}`}
                    faceDown
                    size="md"
                    deal
                    from={p.id === meId ? 'bottom' : 'top'}
                    className="war__card war__card--laid"
                    style={{ '--stack': last?.comparisons.length ?? 0 } as CSSProperties}
                  />
                )}
              </div>
              <span className="war__caption">{p.username}</span>
            </div>
          ))}
          {last && (
            <p className="war__result" role="status">
              {last.winnerId ? (
                <>
                  <Tag>zabiera {names.get(last.winnerId)}</Tag>
                  <Tag>pula {last.poolSize}</Tag>
                </>
              ) : (
                <Tag>brak kart do dokończenia wojny</Tag>
              )}
              {last.comparisons.length > 1 && <Tag>wojna</Tag>}
            </p>
          )}
        </div>

        <div className="felt__row felt__row--me">{me && seat(me, true)}</div>
      </Felt>
      <div className="controls">
        <button
          className="btn btn--primary"
          onClick={onFlip}
          disabled={iFlipped || secondsLeft === null}
        >
          {iFlipped ? 'Czekasz na przeciwnika' : 'Odkryj kartę'}
        </button>
      </div>
    </div>
  );
}
