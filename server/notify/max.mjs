// Адаптер MAX-бота (контракт M3 §1 п. 7). Документация MAX для разработчиков из этой среды
// недоступна (dev.max.ru, platform-api.max.ru закрыты), поэтому клиент той же формы, что
// Telegram ({ configured, call(method, params) }), всегда «не настроен»: доставка сразу
// переходит к следующему каналу и пишет попытку max:skipped (not_configured).
// Когда появится документация, здесь появится настоящий вызов API с MAX_BOT_TOKEN.

export function createMaxBot({ token = null } = {}) {
  return {
    configured: false,
    tokenSet: Boolean(token),
    async call(method) {
      const err = new Error(`max ${method}: not_configured`);
      err.code = 'not_configured';
      throw err;
    },
  };
}
