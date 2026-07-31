# remaude: как развернуть свой экземпляр

Инструкция написана для Claude Code, который будет разворачивать проект новому
владельцу. Читай целиком до начала работы: тут есть несколько мест, где
«очевидное» решение неверно, и они помечены ⚠.

## Что это и из чего состоит

remaude — веб-оболочка для Claude Code: браузерный интерфейс вместо множества
вкладок VS Code, с доступом снаружи (телефон, другой компьютер).

Три части:

```
Браузер (ПК / телефон, PWA)
        │ HTTPS/WSS
        ▼
Relay (маленькая VPS + Caddy)      ← auth, маршрутизация; контент не хранит
        ▲ исходящий WSS
        │
Хост-агент (машина владельца)      ← Agent SDK, файлы, сессии Claude Code
```

- **Хост-агент** (`src/host/`) — Node-процесс на машине, где работает Claude
  Code. Держит живые SDK-сессии, отдаёт веб-интерфейс на `127.0.0.1:7699`,
  сам ходит наружу к relay. Все данные (проекты, транскрипты, токены) — только тут.
- **Relay** (`src/relay/`) — на VPS под публичным доменом. Пускает по Google
  OAuth (жёсткий whitelist), связывает браузеры с хостами, рассылает push.
  Транскрипты через него проходят транзитом, но не сохраняются.
- **Веб-интерфейс** (`src/web/`) — статика, одинаковая локально и через relay.

Ключевая идея: **хост подключается к relay сам, исходящим соединением**. Ни
проброса портов, ни белого IP, ни DDNS — и работает за любым NAT.

## Что понадобится от владельца

1. Своя подписка Claude (Pro/Max) — remaude её не заменяет и не шарит.
2. Домен, которым он управляет (нужна A-запись).
3. Аккаунт AWS (или любой VPS-провайдер; ниже — вариант с AWS Lightsail, ~$5/мес).
4. Google Cloud проект для OAuth-клиента (бесплатно).
5. Список email'ов, кому можно входить (обычно 1–3 своих).

## Порядок развёртывания

### 1. Хост локально (5 минут, сразу видно результат)

```bash
git clone <репозиторий> remaude && cd remaude
npm install
npm start                     # → http://localhost:7699
```

Открой в браузере, нажми «📁 добавить проект». Если работает локально —
переходи к relay. Всё остальное (удалёнка, шаринг, push) — надстройка.

⚠ Требуется Node 20+. Claude Code должен быть установлен и залогинен
(`claude auth status` показывает `"loggedIn": true`) — SDK запускает его как
подпроцесс. Если не залогинен, это можно сделать прямо из UI: ⚙ → «Войти в Claude».

### 2. Google OAuth-клиент

В Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID
→ тип **Web application**:

- Authorized JavaScript origins: `https://<домен>`
- Authorized redirect URIs: `https://<домен>/auth/google/callback`

Сохрани Client ID и Client Secret. ⚠ Секрет не коммить: он кладётся в AWS
Secrets Manager (см. ниже) или в переменные окружения на сервере.

### 3. VPS и DNS

Пример с Lightsail (AWS CLI уже настроен):

```bash
aws lightsail create-key-pair --key-pair-name remaude --region <регион>
# privateKeyBase64 из ответа сохранить как ~/.remaude/lightsail-remaude.pem

aws lightsail create-instances --instance-names remaude-relay \
  --availability-zone <зона> --blueprint-id ubuntu_24_04 --bundle-id nano_3_0 \
  --key-pair-name remaude --region <регион> --user-data file://provision.sh

aws lightsail allocate-static-ip --static-ip-name remaude-ip --region <регион>
aws lightsail attach-static-ip --static-ip-name remaude-ip \
  --instance-name remaude-relay --region <регион>

aws lightsail put-instance-public-ports --instance-name remaude-relay --region <регион> \
  --port-infos '[{"fromPort":22,"toPort":22,"protocol":"tcp"},{"fromPort":80,"toPort":80,"protocol":"tcp"},{"fromPort":443,"toPort":443,"protocol":"tcp"}]'
```

`provision.sh` (user-data) ставит Node 22 и Caddy:

```bash
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
mkdir -p /opt/remaude && chown ubuntu:ubuntu /opt/remaude
```

⚠ Грабли, на которые я уже наступал:

- `--user-data file://...` требует **ASCII-файл с LF**. UTF-16/BOM/CRLF, которые
  по умолчанию делает PowerShell, AWS CLI молча не принимает.
- Не передавай многострочный скрипт как строку в аргументе — PowerShell 5.1
  режет его по пробелам.

Затем A-запись `<домен> → <статический IP>` (Route53 или панель регистратора).
Caddy сам получит TLS-сертификат Let's Encrypt, когда DNS разойдётся.

### 4. Секреты и деплой relay

Скрипт `scripts/deploy-relay.ps1` (Windows) читает два секрета из AWS Secrets
Manager, поэтому в репозитории нет ни доменов, ни IP, ни почт:

```
remaude/google-oauth   {"clientId":"…","clientSecret":"…"}
remaude/relay-deploy   {"instanceIp":"…","domain":"…","whitelist":"a@b.com,c@d.com",
                        "contactEmail":"…","sshKeyPath":"~/.remaude/…pem"}
```

Создать:

```bash
aws secretsmanager create-secret --name remaude/google-oauth --region <регион> \
  --secret-string file://oauth.json
aws secretsmanager create-secret --name remaude/relay-deploy --region <регион> \
  --secret-string file://relay.json
```

⚠ Секрет должен быть **валидным JSON**; PowerShell-хэштаблица в строке даст
`{clientId:…}` без кавычек, и потом это не распарсится.

Дальше просто:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-relay.ps1
```

Скрипт копирует `src/relay` и `src/web`, ставит зависимости, пишет
`/opt/remaude/.env`, systemd-юнит `remaude-relay` и Caddyfile, перезапускает сервисы.

⚠ На relay ставится **отдельный минимальный package.json** (только `ws` и
`web-push`). Корневой тянет Agent SDK, и на инстансе с 512 МБ памяти `npm
install` убивает машину так, что отваливается даже SSH (лечится ребутом через
API провайдера).

Если разворачиваешь не на Windows — перепиши скрипт на bash, логика тривиальная:
собрать `.env`, скопировать два каталога, `npm install --omit=dev`, systemd + Caddy.

### 5. Первый вход и привязка хоста

1. Открыть `https://<домен>` → «Войти через Google» (аккаунт из whitelist).
2. Сайт покажет 6-значный код (хостов ещё нет).
3. В локальном UI (`localhost:7699`): ⚙ → адрес relay + код → «Привязать».
4. Обновить страницу домена — там полноценный интерфейс.

Дальше на телефоне: открыть домен, «Добавить на главный экран» (PWA), в ⚙
включить уведомления.

### 6. Онбординг остальных пользователей (macOS)

`https://<домен>/install.sh` — relay отдаёт его, подставляя свой адрес. Новому
пользователю достаточно:

```bash
curl -fsSL https://<домен>/install.sh | bash
```

Скрипт ставит Node (через brew), Claude Code, логинит, клонирует репозиторий,
вешает launchd-агент с автостартом и открывает локальный UI. Дальше — п.5.

⚠ Он должен быть в whitelist relay, иначе Google-логин упрётся в «не пускаю».
Whitelist меняется в секрете `remaude/relay-deploy` + повторный деплой.

## Модель доступа (важно понимать перед правками)

Три независимых замка:

1. **Аккаунт** — Google OAuth + whitelist. Не в списке — не войдёшь.
2. **Устройство** — доверяется навсегда (подписанная кука, 2 года), если:
   пришло с того же публичного IP, что и хост владельца (то есть из дома);
   либо у аккаунта ещё нет хостов (онбординг); либо одноразовый код с сайта
   введён в настройках уже доверенного устройства.
3. **Хост** — привязан к аккаунту токеном, полученным при пейринге.

Гости (шаринг чатов) не имеют доступа к хосту как таковому: relay пускает их в
туннель владельца со списком разрешённых session id, а хост фильтрует и
состояние, и команды — гостю доступны только чтение и отправка сообщений.

⚠ При правке `readDevice`/`sameNetworkAsHost` помни: X-Forwarded-For доверяется
только когда сокет пришёл с loopback (то есть от Caddy), а сам loopback никогда
не считается «той же сетью» — иначе при потере заголовка доверялись бы все.

## Как всё это устроено внутри

### Хост (`src/host/`)

| Файл | Ответственность |
|---|---|
| `chat.js` | Одна SDK-сессия: очередь ввода, статусы, permissions, лимиты, effort/model |
| `agent.js` | Проекты (директории) → чаты, события наружу |
| `server.js` | HTTP + WS-протокол, конфиг, шаринг, relay-туннель, логин Claude |
| `transcripts.js` | Чтение `~/.claude/projects/**/*.jsonl` для истории и списка сессий |
| `relay-link.js` | Исходящее соединение с relay, туннелирование клиентов |
| `usage.js` | Адаптер данных виджета лимитов |

Ключевые решения, которые лучше не ломать:

- **Чат = живая сессия Agent SDK в streaming-input режиме.** `query()` получает
  async-итератор, который держится открытым между ходами — поэтому можно писать
  модели, пока она работает. Закрытие итератора завершает сессию.
- **История при `resume` не приходит в поток.** SDK восстанавливает контекст, но
  прошлых сообщений не присылает — лента строится чтением JSONL. Формат
  недокументирован, поэтому парсинг best-effort: незнакомые записи пропускаются.
  ⚠ Записи с `origin.kind` (служебные инъекции харнесса) нужно пропускать, иначе
  они отрисуются как сообщения пользователя.
- **Виджет лимитов** берёт данные из
  `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` —
  официально нестабильный метод, изолирован в `usage.js`. Если сломается —
  чинить только там; резервный путь (недокументированный
  `api.anthropic.com/api/oauth/usage`) агрессивно ограничивают по частоте.
- **Открытые чаты переживают рестарт**: список (проект + sessionId + режим)
  лежит в `~/.remaude/host.json` и при старте резюмится автоматически.
- **Самоперезапуск** (`restart_server`): процесс порождает отвязанную копию себя
  и выходит, копия ждёт освобождения порта. ⚠ Ретрай `listen` не сработает, если
  не повесить обработчик `error` на `WebSocketServer`: библиотека `ws`
  переизлучает ошибки http-сервера на себя, и процесс падает раньше ретрая.
  Под супервизором (launchd/systemd, `REMAUDE_SUPERVISED=1`) достаточно выйти.
- **`AskUserQuestion` запрещён** через `canUseTool`: интерактивных опросников в
  вебе нет, модели возвращается отказ с просьбой задать вопросы текстом.
  Этот хук вызывается даже в режиме bypass.

### Relay (`src/relay/`)

Один файл без базы: состояние (cookie-секрет, VAPID-ключи, токены хостов,
push-подписки, пароли устройств) — в `/opt/remaude/relay-state.json`.

- `/auth/google*` — OAuth, проверка `aud` и `email_verified`, whitelist, кука.
- `/pair` — обмен кода привязки на токен хоста.
- `/ws` — браузеры (нужны обе куки: сессия и устройство).
- `/host` — хосты (по токену), туннель: `{t:'open'|'msg'|'close'|'cast'|'push'|'shares'}`.
- `/api/push/*` — VAPID-ключ и подписки.

⚠ `relay-state.json` не бэкапится. Потеря = переподключение всех хостов и
устройств (данные чатов не страдают, они на хостах). Если это важно — добавь
копирование в S3.

### Веб-интерфейс (`src/web/`)

Ванильный JS без сборки — редактируешь файл, обновляешь страницу. `app.js` —
тонкий клиент WS-протокола: рендер ленты (стриминг дельт, свёрнутые
tool-вызовы, сабагенты), сайдбар, permissions, настройки. `md.js` — минимальный
markdown-рендерер, который сначала экранирует HTML и только потом добавляет
разметку (важно: в ленту попадает вывод инструментов).

⚠ Мобильные грабли, уже пройденные: `viewport-fit=cover` загоняет интерфейс под
чёлку — не нужен; `position: fixed` на `body` обязателен, иначе iOS таскает всё
приложение резинкой; правила для `@media (hover: none)` держи **в конце файла**,
иначе они проигрывают по порядку и на телефоне пропадают кнопки.

## Отладка

```bash
# хост
~/.remaude/server.log, server.err.log
# relay
ssh -i <pem> ubuntu@<ip> 'journalctl -u remaude-relay -n 50 --no-pager'
ssh -i <pem> ubuntu@<ip> 'systemctl is-active remaude-relay caddy'
```

В `experiments/` лежат самостоятельные проверки: `test-image.mjs` (картинки во
вводе), `test-usage.mjs` (лимиты), `test-resume.mjs` (возобновление),
`test-ws-client.mjs` (сквозной прогон протокола), `ui-mobile.mjs` (скриншоты
раскладок), `test-restart.mjs` (цикл самоперезапуска). Это исполняемая
документация — при сомнениях запусти соответствующий файл, а не гадай.

## Чего сознательно нет

Диффов и редактора кода (VS Code остаётся редактором), мультихост-переключалки,
LAN-режима без relay, однофайловых бинарников (пока установщик + launchd),
бэкапа состояния relay, ротации сессионных кук и отзыва доступов из UI.
