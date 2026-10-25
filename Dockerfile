FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/app/data/nutrilens.db \
    PORT=8000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --create-home --uid 10001 nutrilens \
    && mkdir -p /app/data \
    && chown -R nutrilens:nutrilens /app/data
USER nutrilens

EXPOSE 8000

# Hosts such as Render set PORT and terminate TLS in front of the app. The proxy flags make the
# sign-in rate limiter see each visitor's real IP instead of the proxy's. Only run this image
# behind such a proxy: with these flags, a client that reaches the container directly could spoof its IP.
CMD ["sh", "-c", "exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
