// Интерфейс турниров для других модулей (контракт M4 §3). db — транзакция вызывающего с контекстом
// клуба (RLS: только турниры этого клуба).
//
//   tournamentHolds(db, { resourceId, from, to }) → [{ from, to, tournament_id, match_id? }]
//       Интервалы, когда стол занят турниром (решение №146): всё окно турнира (starts_at–ends_at)
//       опубликованного турнира (registration, closed, running; черновик — нет), где этот стол — стол турнира,
//       и удержания идущих матчей на столе (scheduled_at–hold_until, могут выйти за ends_at).
//       Брони и игры по QR на эти интервалы не принимаются — и между матчами.
//   matchLightWindow(db, { matchId }) → { status, tournament_status, resource_id, until_max } | null
//       Окно света матча (№147): light продлевает только матч playing и не дальше until_max.
//   События outbox:
//       tournament.match_finished { match_id, tournament_id, club_id, discipline, player_a, player_b, winner_id, loser_id,
//         score: { winner, loser }, score_a, score_b, stage, revision, corrected, finished_at }
//         — winner_id/loser_id — user_id; plus применяет рейтинг ×1,5 (идемпотентно по match_id; revision > 0 —
//         организатор исправил результат, пересчитать).
//   publicTournaments(db, { clubId }) → [T] — афиша клуба для directory (страница клуба).
//       matchForRating(db, { matchId }) — игроки, счёт и дисциплина сыгранного матча для plus.
//       tournament.finished { tournament_id, club_id, discipline, winner_id, participants: [user_id] }
//         — достижения («Турнирный»).
//
// До init() модуля (скрипты, тесты соседей) работает автономный экземпляр: чтение без часов модуля.

import { appendAudit } from '../lib/audit.mjs';
import { enqueue } from '../outbox.mjs';
import { tournamentsOrNull } from './index.mjs';
import { createTournamentService } from './service.mjs';

let standalone = null;

function service() {
  const s = tournamentsOrNull();
  if (s) return s.service;
  if (!standalone) {
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    standalone = createTournamentService({
      log,
      clock: { now: () => new Date() },
      deps: {
        audit: { appendAudit },
        outbox: { enqueue },
        notify: { send: async () => null },
        alarms: { raise: async () => null },
        sse: { publish() {} },
        plus: {},
        payments: {},
        light: {},
      },
    });
  }
  return standalone;
}

/**
 * publicTournamentExists(db, { tournamentId }) → boolean — турнир опубликован (не черновик) у
 * действующего клуба: только для такого открывается публичный поток (M4-7). Кэш 60 с (publicDetail).
 */
export async function publicTournamentExists(db, { tournamentId }) {
  try {
    await service().publicDetail(db, { tournamentId });
    return true;
  } catch (err) {
    if (err?.code === 'not_found') return false;
    throw err;
  }
}

export function tournamentHolds(db, { resourceId, from, to }) {
  return service().holds(db, { resourceId, from, to });
}

/**
 * matchLightWindow(db, { matchId }) → { status, tournament_status, resource_id, until_max } | null —
 * для light (extendFromTournament, решение №147): продлевать свет можно только матчу playing идущего
 * турнира и не дальше until_max — меньший из ends_at + match_minutes и started_at матча + 2 × match_minutes. db — контекст клуба матча.
 */
export function matchLightWindow(db, { matchId }) {
  return service().lightWindow(db, { matchId });
}

/**
 * matchForRating(db, { matchId }) → { match_id, tournament_id, club_id, discipline, player_a, player_b,
 *   score_a, score_b, winner_id, resource_id, revision, finished_at } | null — для plus (рейтинг ×1,5):
 *   только сыгранный матч с игрой (не bye). db — контекст клуба матча.
 */
export function matchForRating(db, { matchId }) {
  return service().matchForRating(db, { matchId });
}

/**
 * publicTournaments(db, { clubId }) → [T] — турниры клуба для страницы клуба на сайте (форма T из
 * docs/contracts/m4-api.md): записи открыты, закрыты, идут и завершённые за 30 дней; без черновиков
 * и без ПДн. Работает и без клуба в контексте (публичная политика), и в контексте этого клуба. Кэш 60 с.
 */
export async function publicTournaments(db, { clubId }) {
  const out = await service().publicList(db, { club: clubId });
  return out.items;
}
