# SignBridge

SignBridge - локальная веб-платформа для демонстрации распознавания жестов камерой и построения понятного плана жестовой визуализации из текста. Интерфейс работает на русском, английском и узбекском языках.

> Важно: это учебный прототип, а не сертифицированный переводчик жестового языка. Распознавание жестов и анимации нужно проверять вместе с носителями конкретного жестового языка. Не используйте результат для медицинских, юридических, экстренных или иных критичных решений.

## Возможности

- Распознавание руки в реальном времени через MediaPipe Hand Landmarker.
- Демонстрационные статические буквы ASL, динамические жесты и накопление слова.
- Текстовый план: глоссы, покрытие словаря, неизвестные и служебные слова.
- Canvas-аватар с последовательностью жестов и озвучивание текста.
- Адаптивный интерфейс без лишней вертикальной прокрутки на широком экране.
- PWA-оболочка: приложение можно установить из поддерживаемого браузера, а статический интерфейс доступен офлайн после первого запуска.
- Версионированное API, валидация входных данных, ограничения размеров кадров и WebSocket-сообщений.

## Быстрый запуск на Windows

Нужен Python 3.10 или новее. На новом компьютере достаточно скачать проект и запустить:

```powershell
git clone https://github.com/m67811/hand.git
cd hand
.\start.bat
```

`start.bat` сам создаёт локальное окружение `.venv`, устанавливает зависимости без прав администратора, скачивает модель рук, выбирает свободный порт начиная с `8000` и открывает браузер только после готовности сервера.

Если `8000` занят, сервер перейдёт на `8001`, затем на следующий свободный порт. Чтобы начать поиск с другого порта, в PowerShell выполните:

```powershell
$env:SIGNBRIDGE_PORT = 8010
.\start.bat
```

## Ручной запуск

Подходит для разработки или систем без `.bat`-файлов:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m backend.download_models
.\.venv\Scripts\python.exe -m uvicorn backend.server:app --host 127.0.0.1 --port 8000 --reload
```

Откройте `http://localhost:8000`. Интерактивная документация API доступна по адресу `http://localhost:8000/docs`.

Для камеры браузер требует защищённый контекст: `localhost` подходит для разработки, а для удалённого сервера нужен HTTPS.

## Запуск в Docker

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Перед публикацией измените в `.env` `SIGNBRIDGE_CORS_ORIGINS` на настоящий адрес сайта и включите `SIGNBRIDGE_ENFORCE_WS_ORIGIN=true`.

## Настройка среды

| Переменная | Назначение | Значение по умолчанию |
| --- | --- | --- |
| `SIGNBRIDGE_PORT` | Начальный порт для `start.bat` и Docker | `8000` |
| `SIGNBRIDGE_NO_BROWSER` | Не открывать браузер из `start.bat` | не задана |
| `SIGNBRIDGE_ENV` | Режим работы API | `development` |
| `SIGNBRIDGE_CORS_ORIGINS` | Разрешённые источники браузера через запятую | локальные адреса на `8000` |
| `SIGNBRIDGE_ENFORCE_WS_ORIGIN` | Проверять Origin в WebSocket | `true` в production, `false` в development |
| `SIGNBRIDGE_MAX_TEXT_LENGTH` | Максимальная длина входного текста | `500` |
| `SIGNBRIDGE_MAX_WS_MESSAGE_BYTES` | Лимит WebSocket-сообщения | `1600000` |
| `SIGNBRIDGE_MAX_FRAME_WIDTH` | Максимальная ширина кадра | `1280` |
| `SIGNBRIDGE_MAX_FRAME_HEIGHT` | Максимальная высота кадра | `720` |
| `SIGNBRIDGE_MAX_AUDIO_BYTES` | Максимальный размер TTS-аудио | `4000000` |
| `SIGNBRIDGE_GESTURE_FRAME_INTERVAL` | Минимальный интервал между кадрами жестов (сек) | `0.0667` |
| `SIGNBRIDGE_AVATAR_REQUEST_INTERVAL` | Минимальный интервал между запросами аватара (сек) | `0.35` |

Полный шаблон переменных находится в [.env.example](.env.example).

## API

| Метод | Адрес | Назначение |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Статус приложения и режима распознавания |
| `GET` | `/api/v1/vocabulary` | Доступные глоссы и словарь |
| `POST` | `/api/v1/translate` | План анимации для `{ "text", "lang" }` |
| `POST` | `/api/v1/tts` | Озвучивание текста в MP3 |
| `POST` | `/api/v1/clear-word` | Очистка накопленного слова |
| `WS` | `/ws/gesture` | Кадры JPEG и результат жеста |
| `WS` | `/ws/avatar` | План анимации и необязательное аудио |

Старые маршруты без `/api/v1` сохранены для совместимости.

## Структура

```text
backend/       FastAPI, WebSocket, распознавание, планировщик и TTS
frontend/      HTML, CSS, JavaScript, PWA-файлы и Canvas-аватар
models/        Скачиваемые модели, не попадают в Git
.github/       Проверки CI
Dockerfile     Контейнерный запуск
start.bat      Автоматический запуск на Windows
```

## Проверки

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m compileall -q backend
.\.venv\Scripts\python.exe -m unittest discover -s backend -p "test_*.py" -v
node --check frontend/app.js
node --check frontend/avatar3d.js
node --check frontend/service-worker.js
```

## Технологии

- Python, FastAPI, Uvicorn и WebSocket.
- MediaPipe Tasks, OpenCV и необязательный классификатор scikit-learn.
- Vanilla JavaScript, Canvas API, Service Worker и Web Speech API.
- gTTS для серверного озвучивания. При недоступности сервера браузер использует встроенный синтез речи.

## Полезные материалы

- [MediaPipe Gesture Recognizer](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer)
- [Руководство MDN по PWA](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/What_is_a_progressive_web_app)
- [Развёртывание FastAPI](https://fastapi.tiangolo.com/deployment/)
