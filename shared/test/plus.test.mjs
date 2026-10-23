import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, levelTitle, nextLevel, matchState, notCountedText, scoreValid, raceScoreValid, ratingLimitText, roundTitle, nickValid } from '../plus.mjs';

test('уровни по PRODUCT §13: границы 1200/1400/1600/1800', () => {
  assert.equal(levelOf(1199).title, 'Новичок');
  assert.equal(levelOf(1200).title, 'Любитель');
  assert.equal(levelOf(1399).title, 'Любитель');
  assert.equal(levelOf(1400).title, 'Опытный');
  assert.equal(levelOf(1600).title, 'Сильный');
  assert.equal(levelOf(1800).title, 'Мастер');
  assert.equal(levelTitle('strong', 1000), 'Сильный', 'уровень сервера важнее');
  assert.deepEqual(nextLevel(1350), { next: 'Опытный', left: 50 });
  assert.equal(nextLevel(1900), null);
});

test('T23: четвёртая партия пары — «в рейтинг не засчитана»', () => {
  assert.equal(notCountedText('pair_daily_limit'), 'в рейтинг не засчитана — 4-я партия пары за сутки');
  assert.equal(notCountedText(null), null);
  const m = { status: 'confirmed', counted: false, players: [{ user_id: 'a', confirmed: true }] };
  assert.equal(matchState(m, 'a').word, 'Не в рейтинге');
  assert.equal(matchState({ status: 'pending', players: [{ user_id: 'a', confirmed: false }] }, 'a').canConfirm, true);
  assert.equal(matchState({ status: 'pending', players: [{ user_id: 'a', confirmed: true }] }, 'a').canConfirm, false);
});

test('счёт: пирамида до 8, матч до N побед', () => {
  assert.equal(scoreValid('pyramid', 8, 5), true);
  assert.equal(scoreValid('pyramid', 7, 5), false);
  assert.equal(scoreValid('pyramid', 8, 8), false);
  assert.equal(scoreValid('pool', 3, 1), true);
  assert.equal(raceScoreValid(3, 3, 2), true);
  assert.equal(raceScoreValid(3, 4, 2), false);
  assert.equal(raceScoreValid(3, 2, 2), false);
});

test('T24: объяснение отказа по рейтингу и раунды сетки', () => {
  assert.match(ratingLimitText({ limit: 1400, rating: 1520 }, 'pyramid'), /до 1400.*«пирамида» — 1520/);
  assert.match(ratingLimitText(null, 'pool'), /выше лимита/);
  assert.equal(roundTitle(1), 'Финал');
  assert.equal(roundTitle(2), 'Полуфинал');
  assert.equal(roundTitle(4), '1/4');
});

test('ник: без телефона и пробелов', () => {
  assert.equal(nickValid('Кий_Мастер'), true);
  assert.equal(nickValid('ab'), false);
  assert.equal(nickValid('Иван Петров'), false);
  assert.equal(nickValid('79991234567'), false);
  assert.equal(nickValid('Shark7777777'), false, 'больше 6 цифр');
  assert.equal(nickValid('Shark777'), true);
  assert.equal(nickValid('Ниндзя_ü'), false, 'только латиница и кириллица');
});
