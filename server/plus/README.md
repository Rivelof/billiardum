# Модуль plus: Бильярдум+

Контракт — `docs/contracts/m4.md` §1 п. 7–10, §3, §4 и `docs/contracts/m4-api.md` («Бильярдум+»); решения №136, №137. Владелец — backend-plus. Миграции — `supabase/migrations/0850_plus.sql`, `0851_plus_review.sql` (правки по ревью: таблицы клуба и города, без «Камбэка»).

| Файл | Что внутри |
|---|---|
| `index.mjs` | `init(ctx)` / `stop()` / `plus()` / `tick()`: подписки outbox `session.closed` (достижения) и `tournament.match_finished` (турнирная партия ×1,5), планировщик истечения партий (30 с, `ctx.plusOptions.tickMs`) |
| `api.mjs` | интерфейс для соседей (ниже); до `init` работает автономно |
| `service.mjs` | профиль, партии, подтверждения, спор, решение управляющего, таблицы, друзья, «Ищу соперника», «Сыграем?», достижения |
| `elo.mjs` | формула Эло, K, уровни, сезон (месяц по Москве), проверка ника и счёта — те же правила, что в базе |
| `deps.mjs`, `errors.mjs` | зависимости от соседей (`ctx.plusDeps` в тестах), ошибки `{status, code}` |
| `api/routes/plus.mjs` | маршруты |

## Рейтинг (PRODUCT §13)

- Дисциплины `pyramid`, `pool`, `snooker` (тип стола `billiard_*`). Старт 1 200; `E = 1/(1+10^((Rb−Ra)/400))`; K = 40, пока сыграно меньше 20 партий дисциплины, затем 20 (у каждого игрока свой); `Δ = round(K × множитель × (S − E))`, половина — от нуля; турнирная партия ×1,5.
- `bl.ratings`: `season = 'all'` — общий рейтинг; `'YYYY-MM'` — сезон (календарный месяц партии по Москве) = 1 200 + сумма Δ за месяц. Уровень — по общему рейтингу: Новичок < 1 200, Любитель 1 200–1 399, Опытный 1 400–1 599, Сильный 1 600–1 799, Мастер ≥ 1 800 (`novice`, `amateur`, `experienced`, `strong`, `master`).
- Рейтинг пишет только `bl.plus_settle_match(match, now)` (SECURITY DEFINER): у `app_api` нет прав на запись `ratings` и `rating_history`; засчитать партию (`counted`) или отклонить по лимиту пары может только эта функция (триггер `matches_guard`). Функция берёт `FOR UPDATE` партии, засчитывает только `confirmed`, повтор — без изменений (`applied: false`), `rating_history` уникальна по `(match_id, user_id)`: двойной пересчёт исключён и при гонке.

## Партии (T22, T23, №148)

1. `POST /api/plus/matches {session_id, discipline, opponent_id, my_score, opponent_score}` — автор должен быть участником сессии (`light.sessionParticipants`; иначе 404), сессия идёт (`active`/`ending`/`grace`) или закрыта не более 30 минут назад (иначе 409 `session_not_active`), сессия не турнирная (409 `tournament_session`), дисциплина — дисциплина стола (400), у обоих есть профиль (409 `no_profile`), счёт без ничьей, в пирамиде у победителя 8 (400). Автор подтверждает своей записью; сопернику — уведомление и SSE `user:{id}` `plus_match`. Соперник не участник сессии — партия сохраняется сразу с `counted: false`, `not_counted_reason: 'not_same_session'`. Вторая неподтверждённая партия той же пары в сессии — 409 `duplicate`.
2. `POST …/{id}/confirm {score_a?, score_b?}` — второй игрок в течение 30 минут (`confirm_until`). Тело — счёт партии, который игрок видел (`players[0].score`, `players[1].score`): не совпал — `409 score_changed`; без тела — без сверки. Оба подтвердили → проверка участия обоих в сессии → `bl.plus_settle_match`: не больше 3 засчитанных партий пары за рабочие сутки клуба (с `settings.day_start_local`, по умолчанию 06:00 по поясу клуба, считаются партии пары во всех клубах; пара блокируется `pg_advisory_xact_lock`), 4-я — `rejected` с причиной `pair_daily_limit`. **№148 (миграция 0852):** у каждого игрока не больше 6 засчитанных партий за те же рабочие сутки клуба партии — по всем соперникам и клубам; 7-я — `rejected` с причиной `player_daily_limit` (уведомление обоим: «в рейтинг не засчитана: лимит партий за сутки»). Гонка: после блокировки пары — advisory-блокировки обоих игроков в порядке id, подсчёт после них. Как и лимит пары — только партии сессий: турнирные партии лимитами не ограничиваются и в счёт не идут. Засчитана — журнал `plus.match_counted`, outbox `plus.match_counted {match_id, club_id, discipline, source, player_ids, winner_id, deltas}`, уведомления `plus.rating`, проверка достижений. Повтор подтверждения — тот же ответ.
3. Нет подтверждения 30 минут — `expired` (`confirm_timeout`): при обращении и планировщиком (`bl.plus_due`), автору уведомление.
4. `POST …/{id}/dispute {reason}` — второй игрок вместо подтверждения: статус `disputed`, журнал `plus.match_dispute` с причиной, уведомление владельцу и управляющему клуба (`important`).
5. `POST /api/plus/matches/{id}/resolve {result: 'a'|'b'|'annul', reason}` — владелец или управляющий клуба партии: причина обязательна (`reason_required`), журнал `plus.match_resolve` (кто, причина, итог) и тревога `manual_action` владельцу и управляющему (стол, решение, сотрудник, причина; инвариант 8, M4-I5): `data {action, match_id, result, staff_id, staff_name, reason, before: '8:6', after: '6:8'|'отменён'}`; в журнале `data.before {score_a, score_b}` — для строки отчёта смены. `a`/`b` — победитель (счёт разворачивается, если не совпадает) и засчитывание по тем же правилам; `annul` — не засчитана (`not_counted_reason: 'annulled'`). Только для `disputed` (иначе 409 `match_not_disputed`).

Вид партии (m4-api.md): `{id, session_id, discipline, players:[{user_id, nick, score, confirmed}], status: pending|confirmed|disputed|expired|resolved, counted: bool|null, not_counted_reason: pair_daily_limit|player_daily_limit|not_same_session|confirm_timeout|annulled|null, confirm_until, rating_delta: {[user_id]: n}|null, tournament, played_at}`. `players[0]` — сторона `a` (автор).

Турнирная партия: outbox `tournament.match_finished {match_id, tournament_id, winner_id, score, …}` → партия `source: 'tournament'` (уникальна по `tournament_match_id`), ×1,5, без подтверждений и лимита пары. Игроки и дисциплина — из `tournaments.matchForRating(db, {matchId})`, если функция есть, иначе из события: `player_ids: [a, b]` или `loser_id`, `discipline`, счёт `score` (`{a, b}`, `{winner, loser}` или `"3:1"`) или `score_a`/`score_b`. Без игроков или дисциплины — лог `plus_tournament_match_skipped`, событие не застревает.

Исправление счёта организатором (№146, 0851): событие `tournament.match_finished` той же партии с `revision > 0` (и `corrected: true`). `bl.plus_correct_match` откатывает прежнее изменение рейтинга записью-коррекцией (`rating_history.kind = 'reversal'`, ревизия новая; рейтинг, партии и победы общего и сезонного рейтинга — ровно на прежнюю дельту), меняет счёт и ревизию партии и применяет новый результат (`kind = 'match'` новой ревизии). Идемпотентно по `(match_id, revision)`: повтор и старая ревизия ничего не меняют, ревизии не по порядку — применяется наибольшая. История только дополняется. Партии, сыгранные после исправляемой, не пересчитываются. Журнал `plus.match_corrected`, уведомления `plus.rating` с новым счётом; в outbox `plus.match_counted` — `revision` и `corrected`. Дельта в виде партии и в истории — текущей ревизии.

## Маршруты

| Метод и путь | Кто | Ответ |
|---|---|---|
| `GET /api/plus/me` | игрок | `{nick\|null, ratings:[{discipline, rating, games, level, season_rating}], achievements:[{code, earned_at}], history:[…20], privacy}` |
| `PATCH /api/plus/me {nick?, privacy?}` | игрок (согласие) | то же; первый раз ник обязателен; 409 `nick_taken` (без учёта регистра); ник 3–20 символов: латиница, кириллица, цифры, `_`, `-`, не больше 6 цифр |
| `GET /api/plus/players/{nick}` | игрок | `{nick, ratings, achievements?, history?}` — скрытое игроком не отдаётся |
| `POST /api/plus/matches`, `GET /api/plus/matches?session_id=` | игроки сессии | партия; `{items}` (без `session_id` — свои последние 30) |
| `POST /api/plus/matches/{id}/confirm`, `…/dispute {reason}` | игрок партии | партия |
| `POST /api/plus/matches/{id}/resolve {result, reason}` | владелец, управляющий | партия |
| `GET /api/clubs/{club}/plus/disputes[?state=all]` | владелец, управляющий | `{items:[партия + dispute_reason, table_number, disputed_at]}` |
| `GET /api/public/rating?discipline&scope=club\|city\|country&club&city&season=YYYY-MM\|all&limit&offset` | без входа (кэш роутера 60 с) | `{items:[{place, nick, level, rating, games}], me: null}` |
| `GET /api/plus/rating?…` | игрок | то же и `me: {place, rating}\|null` |
| `GET/POST/DELETE /api/plus/lfg {discipline, from, to, club_ids}` | игрок | `{lfg\|null, candidates:[{user_id, nick, level, rating, clubs:[name]}]}` |
| `POST /api/plus/invites {to_user_id, discipline, club_id, starts_at, minutes}` | игрок (телефон, согласие) | приглашение; 429 `limit_exceeded` (10 за 24 часа), 409 `duplicate` |
| `GET /api/plus/invites` | игрок | `{incoming, outgoing}` |
| `POST /api/plus/invites/{id}/accept`, `…/decline` | приглашённый | приглашение (`booking_id` после принятия); 409 `booking_conflict` — свободного стола нет |
| `GET /api/plus/friends`, `POST {nick}`, `DELETE /api/plus/friends/{user_id}` | игрок | `{friends:[{user_id, nick, level, in_club_now}], incoming, outgoing}`; 429 `limit_exceeded` (20 заявок за 24 часа) |

Коды ошибок модуля (вне общего словаря): `no_profile`, `tournament_session`, `match_not_pending`, `match_not_disputed`, `invite_not_pending` — все 409.

## Приватность (№137)

- Профиль по умолчанию закрыт: другим — ник, уровень и рейтинг. `privacy`: `show_history`, `show_achievements`, `show_clubs` (название клуба в истории), `friends_see_in_club` — все `false` по умолчанию.
- Карточку собирает `bl.plus_card` для зрителя из контекста: приватность — в базе. Ник соперника в чужой истории виден, только если соперник сам открыл историю (или смотрит он сам).
- Таблицы рейтинга (`bl.plus_rating_table`) — ник, уровень, рейтинг, партии. Страна — все игроки с партиями; клуб и город (№144, 0851) — только игроки с `show_clubs` и засчитанными партиями в этих клубах (город — слаг справочника `bl.cities` или название города клуба). `GET /api/public/rating` — без входа, `me: null`; `GET /api/plus/rating` — то же с местом вошедшего.
- «Друзья в клубе сейчас» (`bl.plus_friends_in_club`) — только друзья с `friends_see_in_club`, только название клуба и время входа.
- «Ищу соперника» (`bl.plus_lfg_candidates`): открытые заявки других игроков той же дисциплины, пересечение времени и клубов, рейтинг ±150.

## «Сыграем?»

Принятие приглашения создаёт общую бронь `bookings.createBooking(db, {userId: пригласивший, resourceId, startsAt, minutes, participants: [принявший]})`: владелец брони — пригласивший (платит и отменяет), стол — первый по номеру стол нужного типа, на котором бронь принимается (409 соседа — следующий стол, в точке сохранения). Пригласившему — уведомление (если нужна предоплата — «Оплатите бронь»).

## Достижения

Коды (как `shared/plus.mjs`): `dry` — победа 8:0 в пирамиде (засчитанная партия сессии), `regular` — 10 закрытых игр (сессий) в одном клубе, `night_shift` — 5 игр, начатых с 00:00 до 06:00 по поясу клуба, `tournament` — засчитанная турнирная партия, `five_clubs` — игры в 5 разных клубах. Проверка — после засчитанной партии и `session.closed`, в личном контексте игрока (свои сессии и партии), в точке сохранения; каждое — один раз (`primary key (user_id, code)`), с уведомлением `plus.achievement`. «Камбэк» («победа после 3:7») в M4 не выдаётся (№145): в данных нет хода счёта внутри партии; кода `comeback` в базе нет (0851).

## Интерфейс для соседей (`api.mjs`)

`ratingOf(db, {userId, discipline}) → {rating, games, level}`, `applyMatch(db, {matchId}) → {status, reject_reason}`, `playerCard(db, {userId, viewerId}) → {user_id, nick, ratings, achievements?, history?} | null` (зритель — пользователь контекста транзакции), `nicksOf(db, {userIds}) → {[user_id]: nick|null}`, `levelOf(rating)`.

## Таблицы и защита (0850)

`players`, `ratings`, `matches`, `match_confirmations`, `rating_history`, `friendships`, `friend_requests`, `lfg`, `invites`, `achievements` — `ENABLE` и `FORCE ROW LEVEL SECURITY`. Своё — по `app.user_id`; партии, подтверждения и история — ещё по `app.club_id` (персонал, обработчики outbox); писать партии и подтверждения — только в контексте клуба партии и только за себя. `DELETE` у `app_api` — только `friendships`. Триггеры `ENABLE ALWAYS` (и для суперпользователя, и в режиме `replica`): `match_confirmations`, `rating_history`, `achievements` — только вставка; `matches` — без удаления, участники и время неизменны, `counted`/`rejected` окончательны, счёт меняется только решением управляющего. Узкие функции (`bl_definer`): `plus_settle_match`, `plus_correct_match`, `plus_briefs`, `plus_user_by_nick`, `plus_card`, `plus_rating_table`, `plus_friends_in_club`, `plus_lfg_candidates`, `plus_due`; для «друзей в клубе» `bl_definer` видит `session_participants(session_id, user_id, joined_at)`.

## Тесты

```sh
npm test -w @billiardum/server                      # plus/test/elo.test.mjs — без базы
DATABASE_ADMIN_URL=postgres://supabase_admin:…@127.0.0.1:54322/postgres \
  node --test --test-concurrency=1 "server/plus/test/db/*.test.mjs"
```

`test/db/harness.mjs` — временная база со всеми миграциями и сидом, второй клуб, настоящий `createApp` с маршрутами `auth.mjs`, `plus.mjs` и модулем plus, light — настоящие `sessionOf`/`sessionParticipants`, `createBooking` — шпион, поддельные часы. `matches.test.mjs` — T22, T23 (граница 06:00), сессия и окно 30 минут, истечение, спор и решение, гонки подтверждений и лимита пары, лимит игрока №148 (по клубам, под гонкой, турнир не в счёт), турнир ×1,5, сверка Эло базы с `elo.mjs`; `social.test.mjs` — профиль и приватность, достижения, таблицы, друзья, соперники, приглашения; `rls.test.mjs` — RLS между клубами и пользователями, права и неизменяемость.
