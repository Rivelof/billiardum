import { useEffect, useState } from 'preact/hooks';
import { formatDate } from '@billiardum/shared/format';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { Icon } from '../../components/Icon.jsx';
import { api } from '../../lib/api.js';
import { linkHandler } from '../../lib/router.js';
import { BASE } from '../../lib/env.js';
import { countWords, qtyWords } from '../../lib/reports.js';
import { PrintHead, printNow, ReportTools } from './common.jsx';

/**
 * Ведомость ревизии для печати (№174): товары по группам, остаток по системе (или «слепая» — без него),
 * пустые колонки «Факт» и «Расхождение», подписи. Ввод факта — экран «Склад» → «Ревизия».
 */
export function AuditSheet({ ctx, today }) {
  const { club, timeZone } = ctx;
  const [groups, setGroups] = useState(null);
  const [blind, setBlind] = useState(false);
  const [error, setError] = useState(null);
  // Ведомость собирает сервер (GET …/stock/sheet?blind=1): в слепой остаток по системе даже не приходит
  useEffect(() => {
    setError(null);
    api
      .stockSheet(club.club_id, blind)
      .then((res) => setGroups((Array.isArray(res?.groups) ? res.groups : []).filter((g) => Array.isArray(g.items) && g.items.length)))
      .catch((err) => setError(err));
  }, [club.club_id, blind]);
  const count = groups?.reduce((s, g) => s + g.items.length, 0) ?? 0;
  return (
    <section class="rscreen rsheet" aria-labelledby="sheet-title">
      <PrintHead club={club} title={blind ? 'Ведомость ревизии (слепая)' : 'Ведомость ревизии'} today={today} timeZone={timeZone} extra={`Дата ревизии: ${formatDate(Date.now(), timeZone)} ____________`} />
      <div class="rhead">
        <h2 class="section-title" id="sheet-title">
          Ведомость ревизии
        </h2>
        <ReportTools onPrint={groups?.length ? printNow : null}>
          <a class="btn btn--quiet btn--sm" href={`${BASE}c/${encodeURIComponent(club.club_id)}/stock`} onClick={linkHandler}>
            <Icon name="box" />
            Ввести факт на «Складе»
          </a>
        </ReportTools>
      </div>
      <label class="dswitch no-print">
        <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.currentTarget.checked)} />
        <span class="dswitch__track" aria-hidden="true">
          <span class="dswitch__knob" />
        </span>
        <span>Слепая ревизия — без остатка по системе</span>
      </label>
      <p class="small muted no-print">Слепая ревизия честнее: считающий не видит, сколько «должно быть», и не подгоняет факт.</p>
      <ErrorNote error={error} />
      {groups ? (
        groups.length ? (
          <>
            <p class="rsummary">{countWords.positions(count)} с учётом остатка</p>
            <div class="tscroll" tabIndex={0} role="region" aria-label="Ведомость ревизии, таблица">
            <table class="rtable rtable--bars rsheet__table">
              <caption class="visually-hidden">Ведомость ревизии</caption>
              <thead>
                <tr>
                  <th scope="col">Товар</th>
                  <th scope="col">Ед.</th>
                  {blind ? null : (
                    <th scope="col" class="num">
                      По системе
                    </th>
                  )}
                  <th scope="col" class="rsheet__blank">
                    Факт
                  </th>
                  <th scope="col" class="rsheet__blank">
                    Расхождение
                  </th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.category_id ?? g.name}>
                  <tr class="rsheet__group">
                    <th scope="colgroup" colSpan={blind ? 4 : 5}>
                      {g.name}
                    </th>
                  </tr>
                  {g.items.map((it) => (
                    <tr key={it.product_id}>
                      <th scope="row">{it.name}</th>
                      <td>{it.unit ?? 'шт'}</td>
                      {blind ? null : <td class="num">{qtyWords(it.system_qty)}</td>}
                      <td class="rsheet__blank" aria-label="пусто, заполняется от руки" />
                      <td class="rsheet__blank" aria-label="пусто, заполняется от руки" />
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
            </div>
            <div class="rsheet__signs">
              <p>Провёл: ______________________ Подпись: __________</p>
              <p>Проверил: ____________________ Подпись: __________</p>
            </div>
          </>
        ) : (
          <p class="muted">Нет товаров с учётом остатка. Включите «Учитывать остаток» у товаров в «Меню».</p>
        )
      ) : !error ? (
        <p class="muted loading" role="status">
          Загружаем остатки…
        </p>
      ) : null}
    </section>
  );
}
