FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SIGNBRIDGE_ENV=production

WORKDIR /app

RUN apt-get update && \
    apt-get install --no-install-recommends -y libegl1 libgl1 libglib2.0-0 libgomp1 libportaudio2 && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --upgrade pip && \
    python -m pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend
COPY models/.gitkeep ./models/.gitkeep

EXPOSE 8000

CMD ["sh", "-c", "python -m backend.download_models || true; exec uvicorn backend.server:app --host 0.0.0.0 --port 8000 --proxy-headers"]
