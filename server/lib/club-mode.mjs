// Режим клуба (M5.1 №153): test | live | suspended. Одна функция «боевой ли клуб» для правил
// денег, ручных действий и чек-листа: live или приостановлен после live (mode_before_suspend).

/**
 * Клуб в боевом режиме: live или приостановлен после live.
 * @param {string|null|undefined} mode bl.clubs.mode
 * @param {string|null|undefined} [modeBeforeSuspend] bl.clubs.mode_before_suspend
 */
export function isLiveClub(mode, modeBeforeSuspend = null) {
  return mode === 'live' || (mode === 'suspended' && modeBeforeSuspend === 'live');
}
