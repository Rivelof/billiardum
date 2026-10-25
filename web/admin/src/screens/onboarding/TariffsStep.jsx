import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../../components/Icon.jsx';
import { TariffWizard, TypedWeek } from '../../components/TariffEditor.jsx';
import { NetworkNote, useClubNetwork } from '../../components/NetworkNote.jsx';
import { api } from '../../lib/api.js';
import { hallTypes, tariffsBody } from '../../lib/tariffs.js';

/**
 * Шаг «Тарифы» (№156): шаблон → цены → предпросмотр недели по часам (общий редактор components/TariffEditor.jsx).
 * Сервер проверяет неделю без дыр и пересечений; 400 tariff_gap | tariff_overlap { weekday, from, to } подсвечивает день и часы.
 * В боевом режиме изменение тарифа — ручное действие с причиной (инвариант 8).
 * M5.5 (№191): клуб сети — плашка «Шаблон сети»; жёсткий шаблон — правка недоступна, мягкий и свои тарифы —
 * «Изменено в клубе» и «Вернуть к шаблону сети».
 */
export function TariffsStep({ ctx, ob, reload, live }) {
  const clubId = ctx.club.club_id;
  const dayStart = /^\d{2}:\d{2}$/.test(ob.day_start_local ?? '') ? ob.day_start_local : '06:00';
  const [types, setTypes] = useState(null);
  const [current, setCurrent] = useState(undefined); // undefined — грузим, null — нет
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [net, reloadNet] = useClubNetwork(clubId);

  const loadRules = () =>
    // GET …/tariffs → { timezone, day_start_local, rules, resource_rules, coverage }
    api.tariffs(clubId).then((r) => setCurrent(Array.isArray(r?.rules) && r.rules.length ? r.rules : null)).catch(() => setCurrent(null));
  useEffect(() => {
    // Типы столов в работе — из списка столов (kind, и смешанный стол тоже)
    api
      .resources(clubId)
      .then((r) => setTypes(hallTypes(r?.resources)))
      .catch(() => setTypes(['pyramid']));
    loadRules();
  }, [clubId]);

  if (!types || current === undefined || net === undefined) return <p class="muted loading">Загружаем тарифы…</p>;
  const tpl = net?.tariffs?.template ? net.tariffs : null;
  const locked = Boolean(tpl?.locked);
  const noteId = 'tw-net-note';
  const networkNote = (
    <NetworkNote
      clubId={clubId}
      network={net}
      scope="tariffs"
      live={live}
      id={noteId}
      onReset={(res) => {
        if (Array.isArray(res?.tariffs?.rules) && res.tariffs.rules.length) setCurrent(res.tariffs.rules);
        else loadRules();
        setEditing(false);
        setNotice(`Тарифы клуба снова по шаблону сети «${net.name}».`);
        reloadNet();
        reload();
      }}
    />
  );

  if ((current && !editing) || locked) {
    return (
      <div class="stack ob__content">
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        {networkNote}
        <p class="lead">Тарифы клуба по дням и часам. Сутки клуба начинаются в {dayStart}: ночь после полуночи считается по предыдущему дню.</p>
        {current ? <TypedWeek rules={current} types={types} dayStart={dayStart} /> : <p class="hint">Тарифов пока нет: их задаст шаблон сети.</p>}
        <div class="row">
          <button type="button" class="btn btn--secondary" onClick={() => setEditing(true)} disabled={locked} aria-describedby={locked ? noteId : undefined}>
            <Icon name={locked ? 'lock' : 'edit'} />
            {locked ? 'Изменить тарифы — задаёт сеть' : 'Изменить тарифы'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="stack">
      {networkNote}
      <TariffWizard
        types={types}
        dayStart={dayStart}
        live={live}
        canCancel={Boolean(current)}
        onCancel={() => setEditing(false)}
        previewNote={
          tpl && !tpl.override ? (
            <p class="note note--lamp">
              <Icon name="chain" />
              <span class="note__title">Свои тарифы вместо шаблона сети «{net.name}»</span>
              <span class="note__body">После сохранения новые версии шаблона сети клуб получать не будет. Вернуть клуб к шаблону можно в любой момент.</span>
            </p>
          ) : null
        }
        onSave={async (rules, reason) => {
          const res = await api.saveTariffs(clubId, tariffsBody(rules, { live, reason }));
          setCurrent(Array.isArray(res?.rules) && res.rules.length ? res.rules : rules);
          setEditing(false);
          setNotice(tpl ? 'Тарифы сохранены. Клуб работает по своим тарифам, не по шаблону сети.' : 'Тарифы сохранены.');
          if (tpl) reloadNet();
          reload();
        }}
      />
    </div>
  );
}
