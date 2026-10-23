// Разбор multipart/form-data из буфера (M5.1 №157: загрузка файла меню формой).
// Тело уже прочитано целиком с пределом (router rawBody). Части: { name, filename, contentType, data }.
// Не больше maxParts частей; заголовки части — до 8 КБ; без вложенного multipart.

export class MultipartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MultipartError';
  }
}

/** boundary из Content-Type; нет — null. */
export function multipartBoundary(contentType) {
  const m = /boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(String(contentType ?? ''));
  return m ? (m[1] ?? m[2]) : null;
}

function headerParam(value, name) {
  const re = new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i');
  const m = re.exec(value);
  if (!m) return null;
  const v = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2].trim();
  return v;
}

/**
 * @param {Buffer} body
 * @param {string} contentType заголовок Content-Type запроса
 * @param {{ maxParts?: number }} [options]
 * @returns {{ name: string|null, filename: string|null, contentType: string|null, data: Buffer }[]}
 */
export function parseMultipart(body, contentType, { maxParts = 10 } = {}) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new MultipartError('boundary');
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new MultipartError('нет разделителя');
  for (;;) {
    pos += delim.length;
    // Последний разделитель: «--boundary--».
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else throw new MultipartError('разделитель');
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0 || headEnd - pos > 8192) throw new MultipartError('заголовки части');
    const head = body.toString('utf8', pos, headEnd);
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    if (next < 0) throw new MultipartError('нет конца части');
    const headers = {};
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const disp = headers['content-disposition'] ?? '';
    if (!/^form-data\b/i.test(disp)) throw new MultipartError('content-disposition');
    parts.push({
      name: headerParam(disp, 'name'),
      filename: headerParam(disp, 'filename'),
      contentType: headers['content-type'] ? headers['content-type'].split(';')[0].trim().toLowerCase() : null,
      data: body.subarray(headEnd + 4, next),
    });
    if (parts.length > maxParts) throw new MultipartError('частей больше предела');
    pos = next + 2;
  }
  return parts;
}
