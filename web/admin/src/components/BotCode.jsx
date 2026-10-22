/**
 * Код подтверждения входа через бота (ревью входа п. 2): 6 цифр крупно, гость отправляет их боту.
 * Без кода с экрана своего браузера чужая ссылка не войдёт; три неверных кода — ссылка сгорает.
 */
export function BotCode({ code, label = 'Отправьте этот код боту' }) {
  if (!code) return null;
  const digits = String(code);
  const shown = digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  return (
    <div class="botcode">
      <p class="botcode__label">{label}</p>
      <p class="botcode__value mono">
        <span aria-hidden="true">{shown}</span>
        <span class="visually-hidden">{digits.split('').join(' ')}</span>
      </p>
    </div>
  );
}
