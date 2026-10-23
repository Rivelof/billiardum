/**
 * Заявки без перезагрузки: форма отправляется на тот же адрес (сервер сайта передаёт её в API), ответ — JSON.
 * Без JS форма уходит обычным POST и возвращается страницей с результатом.
 */
const LABEL = (el) => el.closest('label')?.querySelector('.field__label')?.textContent?.trim() ?? 'поле';

for (const form of document.querySelectorAll('form[data-async-form]')) {
  const status = form.querySelector('.form__status');
  const button = form.querySelector('button[type="submit"]');
  const say = (msg, error) => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle('form__status--error', Boolean(error));
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
    const bad = [...form.elements].find((el) => el.willValidate && !el.checkValidity());
    if (bad) {
      bad.setAttribute('aria-invalid', 'true');
      say(bad.type === 'checkbox' ? 'Отметьте согласие на обработку данных.' : `Заполните поле «${LABEL(bad)}».`, true);
      bad.focus();
      return;
    }
    button.disabled = true;
    say('Отправляем…');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        const done = document.createElement('div');
        done.className = 'note note--free';
        done.setAttribute('role', 'status');
        done.tabIndex = -1;
        const title = document.createElement('p');
        title.className = 'note__title';
        title.textContent = 'Заявка у нас';
        const text = document.createElement('p');
        text.textContent = 'Мы свяжемся с вами по телефону в рабочее время, расскажем о тесте и подключении.';
        done.append(title, text);
        form.replaceWith(done);
        done.focus();
        return;
      }
      say(json.message ?? 'Заявка не отправлена. Попробуйте ещё раз через минуту.', true);
    } catch {
      say('Нет связи с сайтом. Проверьте интернет и отправьте ещё раз.', true);
    }
    button.disabled = false;
  });
}

document.querySelector('[data-focus]')?.focus();
