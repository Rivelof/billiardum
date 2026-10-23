// Интерфейс каталога для других модулей (контракт M4 §3). db — транзакция вызывающего.
//
//   publicClub(db, { city, slug }) → страница клуба (как GET /api/public/clubs/{city}/{slug})
//   publicCity(db, { slug, filters }) → каталог города (как GET /api/public/cities/{slug})
//   clubLiveStatus(db, { clubId }) → { updated_at, free_now, total, plan, tables:[{id, number, title,
//       discipline, plan, status: 'free'|'busy'|'reserved'|'unavailable', busy_until}] } — без ПДн
//
// Требуют запущенного модуля (init); без него — ошибка.

import { directory } from './index.mjs';

export function publicClub(db, { city, slug }) {
  return directory().public.club(db, { city, slug });
}

export function publicCity(db, { slug, filters = {} }) {
  return directory().public.city(db, { slug, query: filters });
}

export function clubLiveStatus(db, { clubId }) {
  return directory().public.clubLiveStatus(db, { clubId });
}
