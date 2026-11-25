FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIZ_MODE=web \
    VIZ_HOST=0.0.0.0 \
    VIZ_PORT=8501 \
    VIZ_DATA_DIR=/data \
    VIZ_SCRATCH_DIR=/tmp/viz-ephem \
    POLARS_MAX_THREADS=4

RUN groupadd --gid 10001 viz \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin viz

WORKDIR /app

COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock

COPY server.py rebuild_surveillance.py LICENSE THIRD_PARTY_NOTICES.md ./
COPY core ./core
COPY remote ./remote
COPY web ./web
COPY next ./next
COPY data ./data

RUN mkdir -p /data /tmp/viz-ephem \
    && chown -R viz:viz /data /tmp/viz-ephem

USER 10001:10001
EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import os, urllib.request; port = os.environ.get('VIZ_PORT', '8501'); urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=3)" || exit 1

ENTRYPOINT ["python", "server.py", "--mode", "web", "--no-auto-hub"]
CMD []
