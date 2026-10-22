// Модуль пакетов часов (M3, decisions №112): init(ctx) и stop().
//
// Своих таймеров и подписок нет: начисление минут идёт в подтверждении платежа (server/payments,
// kind package), срок партий проверяется при чтении баланса, чеки зачёта — через outbox
// money.receipt_settle (server/payments). Модуль подключается в server/http/app.mjs (core)
// после money, чтобы маршруты api/routes/packages.mjs работали в собранном сервере.

let started = false;

export async function init(ctx) {
  started = true;
  ctx.log?.info?.('packages_started', {});
}

export async function stop() {
  started = false;
}

export const isStarted = () => started;
