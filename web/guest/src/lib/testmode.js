/**
 * Тестовый режим клуба (M5.1, №153): гость видит плашку «Тестовый режим клуба — деньги не списываются».
 * Признак — club.mode === 'test' в ответах стола и игры (GET /api/t/{code}, GET /api/sessions/{id});
 * у сессии и платежа может прийти is_test (записи тестового режима, №153). Допущение M5.1: поле club.mode в этих ответах.
 */
export function isTestClub(data) {
  if (!data || typeof data !== 'object') return false;
  return data.club?.mode === 'test' || data.mode === 'test' || data.is_test === true;
}
