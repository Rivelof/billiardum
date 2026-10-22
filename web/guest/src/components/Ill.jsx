import { illustration } from '@billiardum/shared/illustrations';

/** Иллюстрация пустого состояния из бильярдной (shared/illustrations.mjs): декоративная, скрыта от диктора. */
export function Ill({ name }) {
  return <span class="ill-wrap" aria-hidden="true" dangerouslySetInnerHTML={{ __html: illustration(name) }} />;
}
