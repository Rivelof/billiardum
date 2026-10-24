# Образ приложения «Бильярдума» для прода (deploy/prod/compose.yml): сервер, сайт и служебные
# команды. Собирается на сервере из проверенного коммита (deploy/prod/bin/deploy.sh):
#   docker compose … build server   →   billiardum-app:<git sha>
#
# Базовый образ закреплён по дайджесту (decisions №40). Debian, а не Alpine, как у сайта в
# разработке: OG-картинки рисует нативный @resvg/resvg-js (glibc).
# Контекст — корень репозитория, лишнее отсекает deploy/prod/Dockerfile.dockerignore.

# --- Сборка: зависимости, фронтенд, отбор файлов --------------------------------------------
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /src
ENV CI=1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Сначала только манифесты: слой с node_modules пересобирается, когда меняются зависимости.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY supabase/package.json supabase/
COPY server/package.json server/
COPY tools/device-sim/package.json tools/device-sim/
COPY tools/kkt-bridge/package.json tools/kkt-bridge/
COPY tools/yookassa-emu/package.json tools/yookassa-emu/
COPY web/guest/package.json web/guest/
COPY web/admin/package.json web/admin/
COPY web/site/package.json web/site/
RUN npm ci

COPY . .

# Фронтенд в боевом режиме: без заглушки API и без входа для разработки (vite build — mode
# production; VITE_MOCK и VITE_DEV_LOGIN пустые). Заглушка в сборке — ошибка сборки.
ENV VITE_MOCK= VITE_DEV_LOGIN=
RUN npm run build -w web/guest \
 && npm run build -w web/admin \
 && npm run build -w web/site \
 && if grep -rl BL_MOCK_MARKER web/guest/dist web/admin/dist; then echo 'заглушка API попала в сборку' >&2; exit 1; fi

RUN npm prune --omit=dev

# В образ идёт только то, что нужно в проде: без эмуляторов, симулятора, моста ККТ, тестов,
# сида, провижининга разработки и заглушки сайта.
RUN set -eu; \
    mkdir -p /out/supabase /out/web/guest /out/web/admin /out/scripts /out/deploy/prod/bin; \
    cp -a package.json package-lock.json node_modules server api shared /out/; \
    cp -a supabase/package.json supabase/lib supabase/bin supabase/migrations /out/supabase/; \
    rm -f /out/supabase/bin/seed.mjs /out/supabase/bin/reset.mjs; \
    cp -a web/guest/package.json web/guest/dist /out/web/guest/; \
    cp -a web/admin/package.json web/admin/dist /out/web/admin/; \
    cp -a web/site /out/web/site; \
    rm -rf /out/web/site/mock /out/web/site/scripts /out/web/site/test /out/web/site/node_modules; \
    cp -a scripts/provision-factory.mjs /out/scripts/; \
    cp -a deploy/prod/bin/mqtt-server-client.mjs deploy/prod/bin/publish-web.sh /out/deploy/prod/bin/; \
    rm -f /out/server/bin/provision-dev.mjs /out/server/devices/provision-dev.mjs /out/server/payments/provision-dev.mjs; \
    find /out -path /out/node_modules -prune \
      -o -type d -name test -prune -print \
      -o -type f -name '*.test.mjs' -print | xargs -r rm -rf; \
    if [ -e /out/supabase/seed.sql ] || [ -d /out/tools ]; then echo 'в образ попали сид или tools/' >&2; exit 1; fi

# --- Прод ---------------------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# Код принадлежит root и только читается; процессы — от пользователя node (uid 1000).
USER node
CMD ["node", "server/index.mjs"]
