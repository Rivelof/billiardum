// Слаги сайта (M4 §1 п. 2): латиница, транслит по ГОСТ-подобной схеме без диакритики,
// нижний регистр, слова через дефис. «Бильярдный клуб «Пирамида»» → bilyardnyy-klub-piramida.

const MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Транслит строки в слаг (может вернуть пустую строку, если букв нет). */
export function slugify(text, max = 60) {
  const lower = String(text ?? '').toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (MAP[ch] !== undefined) out += MAP[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (out.length > max) out = out.slice(0, max).replace(/-[^-]*$/, '') || out.slice(0, max);
  return out.replace(/-$/, '');
}

/** Свободный слаг: base, base-2, base-3 … (exists(slug) → boolean). */
export async function uniqueSlug(base, exists, max = 80) {
  const root = slugify(base, max - 4) || 'klub';
  if (!(await exists(root))) return root;
  for (let i = 2; i < 1000; i += 1) {
    const s = `${root}-${i}`;
    if (!(await exists(s))) return s;
  }
  throw new Error('uniqueSlug: нет свободного слага');
}
