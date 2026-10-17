# MacroPulse API — production image. Matches the local interpreter (Python 3.15) exactly.
FROM python:3.15-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Hosts (Render, Railway, Fly) inject PORT; gunicorn.conf.py binds to it.
EXPOSE 8000
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]
