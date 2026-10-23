import { Icon } from './Icon.jsx';

/** Плашка тестового режима клуба (M5.1): статус словом и значком, не только цветом. */
export function TestModeNote() {
  return (
    <p class="note note--lamp testmode" role="note">
      <Icon name="flask" />
      <span class="note__title">Тестовый режим клуба — деньги не списываются</span>
    </p>
  );
}
