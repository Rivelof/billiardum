# Пробы X-Forwarded-For (запускаются из отдельного контейнера, свой IP — лимиты тестера не задеваются)

```
cp <корень Caddy root.crt> tests/security/m4/probes/caddy-root.crt
docker run --rm --network billiardum_default -v $PWD/tests/security/m4/probes:/probe:ro node:22.23.4-alpine node /probe/xff_via_caddy.mjs
docker run --rm --network billiardum_default -v $PWD/tests/security/m4/probes:/probe:ro node:22.23.4-alpine node /probe/xff_inner_network.mjs
```

- `xff_via_caddy.mjs` — через Caddy поддельный XFF игнорируется: 31-й запрос к маршруту с лимитом 30/мин → 429 (выдержало).
- `xff_inner_network.mjs` — изнутри сети Docker прямо на `server:3000`: XFF с адресом сайта снимает лимит
  публичного API (замечание M4-I4: `TRUSTED_PROXY_CIDRS` по умолчанию — все частные сети).
