import { useEffect, useState } from 'preact/hooks';
import { formatMoney, plural } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import { linkHandler } from '../../lib/router.js';
import { BASE } from '../../lib/env.js';
import { CSV_SAMPLE, menuFromCsv, serverCsvError } from '../../lib/csv.js';

const PRODUCTS = ['товар', 'товара', 'товаров'];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES = 2 * 1024 * 1024;

/** Файл меню: .xlsx — телом запроса как есть, .csv — текстом в JSON, как раньше (M2). */
export function menuFileKind(file) {
  const name = String(file?.name ?? '').toLowerCase();
  if (name.endsWith('.xlsx') || file?.type === XLSX) return 'xlsx';
  if (name.endsWith('.csv') || /csv|text\/plain/.test(file?.type ?? '')) return 'csv';
  return null;
}

/**
 * Шаг «Меню бара» (№157): загрузка из Excel (.xlsx) или CSV. Обязательный предпросмотр — сервер разбирает файл
 * с dry_run и показывает, что добавится и что обновится; меню меняется только после «Загрузить в меню».
 */
export function MenuStep({ ctx, reload }) {
  const clubId = ctx.club.club_id;
  const [count, setCount] = useState(null);
  const [file, setFile] = useState(null); // { file, kind, text? }
  const [preview, setPreview] = useState(null);
  const [localRows, setLocalRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [done, setDone] = useState(null);

  const loadCount = () =>
    api
      .catalog(clubId)
      .then((c) => setCount((c?.products ?? []).filter((p) => p.active !== false).length))
      .catch(() => setCount(null));
  useEffect(() => {
    loadCount();
  }, [clubId]);

  const send = (f, dryRun) => (f.kind === 'xlsx' ? api.importMenuFile(clubId, f.file, XLSX, dryRun) : api.importMenu(clubId, f.text, dryRun));

  const choose = async (picked) => {
    setPreview(null);
    setLocalRows(null);
    setError(null);
    setFileError(null);
    setDone(null);
    setFile(null);
    if (!picked) return;
    const kind = menuFileKind(picked);
    if (!kind) return setFileError('Нужен файл Excel (.xlsx) или CSV. Старый формат .xls сохраните заново как «Книга Excel».');
    if (picked.size > MAX_BYTES) return setFileError('Файл больше 2 МБ. Уберите из таблицы картинки и лишние листы или разбейте меню на части.');
    const f = { file: picked, kind, name: picked.name };
    if (kind === 'csv') {
      f.text = await picked.text();
      const parsed = menuFromCsv(f.text);
      setLocalRows(parsed.rows);
    }
    setFile(f);
    setBusy(true);
    try {
      setPreview((await send(f, true)) ?? {});
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await send(file, false)) ?? {};
      if (res.applied === false && res.errors?.length) {
        setPreview(res);
        return;
      }
      setDone(res);
      setFile(null);
      setPreview(null);
      loadCount();
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const sample = () => {
    const url = URL.createObjectURL(new Blob([`\uFEFF${CSV_SAMPLE}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'menu-sample.csv';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const errors = Array.isArray(preview?.errors) ? preview.errors : [];
  const rows = Array.isArray(preview?.rows) ? preview.rows : localRows ?? [];
  const total = (preview?.created ?? 0) + (preview?.updated ?? 0);
  const ready = preview && !errors.length && total > 0;

  return (
    <div class="stack ob__content">
      <p class="lead">Загрузите меню бара таблицей — ресепшн будет продавать его на кассе, гости — заказывать со стола.</p>
      <p class="hint">
        {count === null ? '' : count ? `Сейчас в меню ${count} ${plural(count, PRODUCTS)}. ` : 'Меню пока пустое. '}
        Первая строка — заголовки: «название» и «цена» обязательно; по желанию — «категория», «ед», «алкоголь» (да или нет), «ндс». Товар с тем же названием обновится.
      </p>
      <div class="row">
        <label class="btn btn--primary file">
          <Icon name="upload" />
          {file ? 'Выбрать другой файл' : 'Выбрать файл Excel или CSV'}
          <input class="file__input" type="file" accept={`.xlsx,.csv,${XLSX},text/csv`} onChange={(e) => choose(e.currentTarget.files?.[0])} />
        </label>
        <button type="button" class="btn btn--link" onClick={sample}>
          Скачать образец
        </button>
      </div>
      <p class="small muted">До 2 МБ и 5 000 строк. Берётся первый лист; формулы и макросы не выполняются — нужны сами значения.</p>

      {fileError ? (
        <p class="note note--error" role="alert">
          <Icon name="alert" />
          <span class="note__title">{fileError}</span>
        </p>
      ) : null}
      <ErrorNote error={error} />
      {busy && !preview ? (
        <p class="muted loading" role="status">
          Читаем «{file?.name}»…
        </p>
      ) : null}

      {done ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">
            Меню загружено: добавлено {done.created ?? 0}, обновлено {done.updated ?? 0}.
          </span>
        </p>
      ) : null}

      {preview ? (
        <section class="panel mi" aria-labelledby="mi-title">
          <h3 class="section-title" id="mi-title">
            Предпросмотр: {file?.name}
          </h3>
          {errors.length ? (
            <div class="note note--error" role="alert">
              <Icon name="alert" />
              <p class="note__title">
                {errors.length} {plural(errors.length, ['ошибка', 'ошибки', 'ошибок'])} — меню не изменится, пока их не исправить
              </p>
              <ul class="note__body csv__errors">
                {errors.slice(0, 8).map((x, i) => (
                  <li key={`${x.line}-${i}`}>{serverCsvError(x)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p>
              Будет добавлено <b>{preview.created ?? 0}</b>, обновлено <b>{preview.updated ?? 0}</b>
              {preview.categories_created?.length ? `, новые категории: ${preview.categories_created.join(', ')}` : ''}.
            </p>
          )}
          {rows.length ? (
            <div class="csv__preview">
              <table class="rtable">
                <caption>
                  {rows.length} {plural(rows.length, PRODUCTS)} в файле
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Категория</th>
                    <th scope="col">Название</th>
                    <th scope="col" class="num">
                      Цена
                    </th>
                    <th scope="col">Алкоголь</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 12).map((r, i) => (
                    <tr key={`${r.line ?? i}`}>
                      <td data-label="Категория">{r.category ?? 'Другое'}</td>
                      <th scope="row">{r.name}</th>
                      <td class="num mono" data-label="Цена">
                        {Number.isFinite(r.price_kopecks) ? formatMoney(r.price_kopecks) : '—'}
                      </td>
                      <td data-label="Алкоголь">{r.is_alcohol ? 'да' : 'нет'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 12 ? <p class="small">И ещё {rows.length - 12}.</p> : null}
            </div>
          ) : null}
          {rows.some((r) => r.is_alcohol) ? (
            <p class="note note--lamp">
              <Icon name="info" />
              <span class="note__title">Алкоголь продаётся только на кассе ресепшена: в QR-меню гостя его не будет.</span>
            </p>
          ) : null}
          <div class="row">
            <button type="button" class="btn btn--primary btn--lg" disabled={!ready || busy} onClick={apply}>
              <Icon name="upload" />
              {busy ? 'Загружаем…' : ready ? `Загрузить в меню: ${total} ${plural(total, PRODUCTS)}` : 'Загрузить в меню'}
            </button>
            <button
              type="button"
              class="btn btn--quiet"
              onClick={() => {
                setPreview(null);
                setFile(null);
              }}
            >
              Не загружать
            </button>
          </div>
        </section>
      ) : null}

      <a class="btn btn--link" href={`${BASE}c/${encodeURIComponent(ctx.club.club_id)}/menu`} onClick={linkHandler}>
        Открыть меню целиком: цены, модификаторы, стоп-лист
      </a>
    </div>
  );
}
