#!/bin/sh
# Сборки web/guest и web/admin из образа выпуска → том web-static, который раздаёт Caddy
# (сервис web-publish в deploy/prod/compose.yml; вызывает deploy/prod/bin/deploy.sh).
#
# Без перезапуска Caddy и без «дыры» для открытых вкладок:
#   * ассеты с хешем в имени (assets/) только добавляются; старые, которых нет в выпуске,
#     удаляются через 14 дней — открытая вкладка со старой версией догружает свои файлы;
#   * остальные файлы (index.html, sw.js, манифест, иконки) заменяются переименованием.
# Запускается в контейнере: /app — образ выпуска, /srv/web — том.

set -eu

SRC_ROOT=${PUBLISH_SRC_ROOT:-/app/web}
DST_ROOT=${PUBLISH_DST_ROOT:-/srv/web}
KEEP_OLD_ASSETS_DAYS=14

publish() {
  app=$1
  src="$SRC_ROOT/$app/dist"
  dst="$DST_ROOT/$app"
  [ -f "$src/index.html" ] || { echo "publish-web: нет сборки $src" >&2; exit 1; }
  mkdir -p "$dst/assets"

  # 1. Новые ассеты: копия во временный файл и переименование (файл появляется целиком).
  added=0
  if [ -d "$src/assets" ]; then
    for f in "$src"/assets/*; do
      [ -f "$f" ] || continue
      name=$(basename "$f")
      if [ ! -e "$dst/assets/$name" ]; then
        cp "$f" "$dst/assets/.$name.tmp"
        mv -f "$dst/assets/.$name.tmp" "$dst/assets/$name"
        added=$((added + 1))
      fi
    done
  fi

  # 2. Остальное: каждый верхний файл и папку — рядом и переименованием поверх.
  for f in "$src"/* "$src"/.[!.]*; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    [ "$name" = assets ] && continue
    rm -rf "$dst/.$name.new" "$dst/.$name.old"
    cp -R "$f" "$dst/.$name.new"
    if [ -d "$dst/$name" ] && [ ! -L "$dst/$name" ]; then
      mv "$dst/$name" "$dst/.$name.old"
    fi
    mv -f "$dst/.$name.new" "$dst/$name"
    rm -rf "$dst/.$name.old"
  done

  # 3. Старые ассеты, которых нет в этом выпуске, — старше 14 дней.
  removed=0
  for f in "$dst"/assets/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    [ -e "$src/assets/$name" ] && continue
    if [ -n "$(find "$f" -mtime +"$KEEP_OLD_ASSETS_DAYS" -print)" ]; then
      rm -f "$f"
      removed=$((removed + 1))
    fi
  done
  echo "publish-web: $app — добавлено ассетов $added, удалено старых $removed"
}

publish guest
publish admin
