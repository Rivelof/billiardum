#!/usr/bin/env bash
# Еженедельный отчёт пилота Андрею (ROADMAP «Пилот», PRODUCT §21): billiardum-pilot-report.timer,
# понедельник 09:07 по Москве. Метрики за 7 дней по каждому боевому клубу — pilot-metrics.sql.
# В отчёте только числа и название клуба, без персональных данных.
#   pilot-report.sh            — отправить
#   pilot-report.sh --print    — только напечатать

. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../bin/lib.sh"
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/notify.sh"

pct() { (($2 > 0)) && printf '%s %%' $(($1 * 100 / $2)) || printf '—'; }
rub() { # копейки → «1 490 ₽», «150,50 ₽» (ru-RU: разряды через пробел, копейки — если есть)
  local r=$(($1 / 100)) k=$(($1 % 100)) out=''
  while ((r >= 1000)); do out=$(printf ' %03d' $((r % 1000)))$out r=$((r / 1000)); done
  if ((k > 0)); then printf '%s%s,%02d ₽' "$r" "$out" "$k"; else printf '%s%s ₽' "$r" "$out"; fi
}

# Строки pilot-metrics.sql → текст отчёта.
format_report() {
  local from=$1 to=$2 line text
  text="Пилот: неделя $from – $to"
  while IFS='|' read -r name games no_staff cmds_nolog games_nolog shifts off off_unexpl off_kop median scan_n ext ext_app; do
    [[ -n $name ]] || continue
    text+=$'\n\n'"$name"
    text+=$'\n'"- игр $games, без участия персонала $(pct "$no_staff" "$games") (цель 80 % и выше)"
    text+=$'\n'"- свет без записи в журнале: команд $cmds_nolog, игр $games_nolog (цель 0)"
    if ((shifts > 0)); then
      text+=$'\n'"- смен закрыто $shifts, с расхождением кассы $off (без объяснения $off_unexpl), всего $(rub "$off_kop")"
    else
      text+=$'\n'"- закрытых смен нет"
    fi
    if ((median >= 0)); then
      text+=$'\n'"- от скана QR до света: медиана $median с по $scan_n играм (цель меньше 20 с)"
    else
      text+=$'\n'"- от скана QR до света: нет игр по QR с оплатой"
    fi
    text+=$'\n'"- продлений $ext, из приложения $(pct "$ext_app" "$ext")"
  done
  printf '%s\n' "$text"
}

main() {
  bl_load_env
  local out from to report
  out=$(bl_psql <"$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/pilot-metrics.sql") || bl_die "запрос метрик пилота не прошёл"
  from=$(TZ=${MONITOR_TZ:-Europe/Moscow} date -d '7 days ago' '+%d.%m')
  to=$(TZ=${MONITOR_TZ:-Europe/Moscow} date '+%d.%m')
  report=$(format_report "$from" "$to" <<<"$out")
  [[ -n $out ]] || report+=$'\n'"Боевых клубов пока нет."
  if [[ ${1:-} == --print ]]; then printf '%s\n' "$report"; else bl_notify_send "$report" || bl_die "отчёт не доставлен"; fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
