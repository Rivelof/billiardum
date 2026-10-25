// Клубы запроса дашборда и историй (№166, §7): один клуб из пути (роли проверил роутер) или
// «Все мои клубы» — клубы, где пользователь в одной из ролей (личный контекст, свои членства).
// У токена PIN — только клуб его терминала. Ни одного — 403. allowNetwork: false (M5.5 №192) — без
// клубов, где пользователь — управляющий сети (экспорт, деньги по способам оплаты): один клуб — 403.

import { HttpError } from '../http/errors.mjs';
import { loadClub } from './store.mjs';

async function myClubs(ctx, req, roles, allowNetwork) {
  await ctx.useClub(null);
  const { rows } = await ctx.db.query(
    'select club_id from bl.club_members where user_id = $1 and active and role = any($2::text[]) order by club_id',
    [req.user.id, roles],
  );
  const bound = req.principal?.clubId ?? null;
  const ids = [...new Set(rows.map((r) => r.club_id))].filter((id) => !bound || id === bound);
  const clubs = [];
  for (const id of ids) {
    const got = await ctx.useClub(id);
    if (!got.some((r) => roles.includes(r))) continue;
    // M5.5 №192: управляющий сети (членство через сеть) — без экспорта и денег по способам оплаты.
    const viaNetwork = Boolean(ctx.networkManager);
    if (viaNetwork && !allowNetwork) continue;
    const c = await loadClub(ctx.db, id);
    if (c) clubs.push({ ...c, viaNetwork });
  }
  if (clubs.length === 0) throw new HttpError(403, 'forbidden');
  return clubs;
}

/**
 * @returns {Promise<{ clubs: object[], all: boolean, key: string, enter: (club) => Promise<void> }>}
 */
export async function clubScope(ctx, req, { all, roles, allowNetwork = true }) {
  if (all) {
    const clubs = await myClubs(ctx, req, roles, allowNetwork);
    return {
      clubs,
      all: true,
      key: `all:${req.user.id}:${req.principal?.clubId ?? ''}:${roles.join(',')}:${allowNetwork ? 'n' : ''}`,
      enter: async (c) => {
        await ctx.useClub(c.id);
      },
    };
  }
  const club = await loadClub(ctx.db, ctx.club);
  if (!club) throw new HttpError(404, 'not_found');
  const viaNetwork = Boolean(ctx.networkManager);
  if (viaNetwork && !allowNetwork) throw new HttpError(403, 'forbidden', { detail: 'network manager' });
  return {
    clubs: [{ ...club, viaNetwork }],
    all: false,
    key: `${club.id}${viaNetwork ? ':n' : ''}`,
    enter: async (c) => {
      if (c.id !== ctx.club) throw new Error('scope: чужой клуб');
    },
  };
}
