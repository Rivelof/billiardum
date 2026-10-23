# M4: формы ответов API (дополнение к docs/contracts/m4.md §4)

Предложены frontend, приняты оркестратором как основа. Отклонение — через оркестратора; бэкенд может сократить поле, если оно раскрывает ПДн.

## Бильярдум+

- `GET/PATCH /api/plus/me` → `{ nick|null, ratings:[{discipline:'pyramid'|'pool'|'snooker', rating, games, level, season_rating}], achievements:[{code, earned_at}], history:[{match_id, discipline, opponent_nick, my_score, opponent_score, result:'win'|'loss', delta|null, counted, not_counted_reason|null, at, club_name, tournament:bool}], privacy:{show_history, show_achievements, show_clubs, friends_see_in_club} }`; PATCH `{nick?, privacy?}`, 409 `nick_taken`. `GET /api/plus/players/{nick}` — то же без скрытых полей.
- `POST /api/plus/matches {session_id, discipline, opponent_id, my_score, opponent_score}` → `match {id, session_id, discipline, players:[{user_id, nick, score, confirmed}], status:'pending'|'confirmed'|'disputed'|'expired'|'resolved', counted:bool|null, not_counted_reason:'pair_daily_limit'|'not_same_session'|'confirm_timeout'|null, confirm_until, rating_delta:{[user_id]:n}|null}`; `GET /api/plus/matches?session_id=`; `POST …/{id}/confirm`, `…/{id}/dispute {reason}`.
- **light:** `GET /api/sessions/{id}` отдаёт участникам `participants:[{user_id, nick|null}]` — нужно для выбора соперника.
- `GET /api/public/rating?discipline&scope=club|city|country&club&city&season=YYYY-MM|all` → `{items:[{place, nick, level, rating, games}], me:{place, rating}|null}`.
- `GET/POST/DELETE /api/plus/lfg {discipline, from, to, club_ids}` → `{lfg|null, candidates:[{user_id, nick, level, rating, clubs:[name]}]}`; `POST /api/plus/invites {to_user_id, discipline, club_id, starts_at, minutes}` (429 `limit_exceeded`); `GET /api/plus/invites` → `{incoming:[invite], outgoing:[invite]}`, invite `{id, from:{nick}, to:{nick}, discipline, club:{id,name}, starts_at, minutes, status:'pending'|'accepted'|'declined'|'expired', booking_id|null}`; `POST …/{id}/accept` → invite с `booking_id`, `…/{id}/decline`.
- `GET /api/plus/friends` → `{friends:[{user_id, nick, level, in_club_now:{club_name, since}|null}], incoming:[{user_id, nick}], outgoing:[{user_id, nick}]}`; `POST {nick}`; `DELETE /api/plus/friends/{user_id}`.

## Турниры

- `GET /api/public/tournaments` → `{items:[T]}`, T `{id, title, club:{id,name,city}, discipline, format:'single_elim'|'groups_playoff', race_to, rating_limit|null, fee_kopecks, prize_text, places, entries_count, starts_at, ends_at, status:'registration'|'closed'|'running'|'finished'|'canceled'}`.
- `GET /api/public/tournaments/{id}` → T + `entries:[{nick, seed, rating}]` + `bracket:{rounds:[{title, matches:[{id, table_number, a:{nick,seed}|null, b, score_a, score_b, status:'scheduled'|'playing'|'pending_confirm'|'disputed'|'done', winner:'a'|'b'|null}]}]}`.
- `GET /api/tournaments/{id}/me` → `{entry:{id, status:'pending_payment'|'confirmed'|'canceled'}|null, match:{id, side:'a'|'b', opponent_nick, score_a, score_b, status, i_confirmed}|null}`.
- `POST /api/tournaments/{id}/entries {return_url}` → `{entry_id, status, confirmation:{url}|null}`; 409 `rating_above_limit` с полями `limit` и `rating` (**core:** добавить в белый список полей ошибок).
- Счёт: `POST /api/tournaments/matches/{id}/score {score_a, score_b}`, `…/confirm`, `PATCH …/score {score_a, score_b, reason}`.
- Клуб: `GET/POST /api/clubs/{club}/tournaments` (тело `{title, discipline, format, race_to, rating_limit, fee_kopecks, prize_text, places, starts_at, ends_at, resource_ids}`), `GET /api/clubs/{club}/tournaments/{id}` → T + `entries:[{entry_id, nick, rating, seed, status, paid}]` + bracket, PATCH, `POST …/start`, `POST …/cancel {reason}` → `{refunded}`.
- SSE `tournament:{id}`: событие `bracket` с полным bracket.

## Отзывы, заявки, оператор

- `POST /api/reviews {club_id, rating, text}` (403 `review_not_allowed`), `GET /api/reviews/mine?club_id=` → review|null; клуб: `GET /api/clubs/{club}/reviews` → `{items:[{id, rating, text, author_nick, created_at, reply:{text, at}|null, reported}]}`, `POST /api/reviews/{id}/reply {text}`, `POST …/report {reason}`.
- Карточка: `GET/PATCH /api/clubs/{club}/listing {id, status:'listed'|'claimed'|'platform', name, city, address, phone, description, hours_text, url}`.
- Заявка T25 (`/app/request/{listing_id}`): `GET /api/public/listings/{id}` → `{id, name, city, address, status}`; `POST /api/clubs/requests {listing_id, starts_at, minutes, people, comment}` → `{id, status}`; `GET /api/clubs/requests/{id}` → `{id, status:'sent'|'accepted'|'declined'|'operator'|'closed', club:{name}, starts_at, minutes, people, answer_text|null, updated_at}`.
- Споры: `GET /api/clubs/{club}/plus/disputes` → `{items:[match + dispute_reason, table_number]}`, `POST /api/plus/matches/{id}/resolve {result:'a'|'b'|'annul', reason}`.
- Оператор: `GET /api/me` → `user.platform_role 'platform_operator'|'platform_admin'|null`; `GET/PATCH /api/platform/{requests|leads|listings|reports}` → `{items}`, PATCH `{status|action, reason}`.
