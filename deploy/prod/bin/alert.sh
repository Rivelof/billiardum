#!/usr/bin/env bash
# Тревога Андрею, что служба systemd упала (OnFailure= у бэкапа, WAL, монитора, проверки
# восстановления, отчёта): billiardum-alert@<служба>.service. Последние строки журнала службы
# в тревогу не идут (могут быть подробности) — только имя и команда для просмотра.

. "$(dirname "$(readlink -f "$0")")/lib.sh"
. "$BL_ROOT/deploy/prod/monitor/notify.sh"
bl_load_env

unit=${1:-неизвестная}
[[ $unit =~ ^[A-Za-z0-9@._-]+$ ]] || unit=неизвестная
key="unit_${unit//[^A-Za-z0-9_]/_}"
bl_alert "$key" critical "служба $unit завершилась с ошибкой. Журнал: journalctl -u $unit -n 50"
