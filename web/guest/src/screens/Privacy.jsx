import { Header } from '../components/Header.jsx';
import { BASE } from '../lib/env.js';

/** Политика обработки персональных данных. Текст готовит юрист (docs/legal/privacy.md) — до него заглушка. */
export function Privacy() {
  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content">
        <h1 class="page-title display">Политика обработки персональных данных</h1>
        <div class="empty">
          <p class="lead">Текст готовит юрист.</p>
          <p class="hint">
            Здесь будет полная политика по 152‑ФЗ: какие данные мы храним (номер телефона и история игр), зачем, где (серверы в России) и как
            отозвать согласие. Пока текста нет, напишите в клуб, если хотите удалить свои данные.
          </p>
        </div>
      </main>
    </div>
  );
}
