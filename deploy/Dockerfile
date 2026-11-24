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

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=viz:viz server.py THIRD_PARTY_NOTICES.md ./
COPY --chown=viz:viz core ./core
COPY --chown=viz:viz remote ./remote
COPY --chown=viz:viz web ./web
COPY --chown=viz:viz next ./next
COPY --chown=viz:viz data ./data

RUN mkdir -p /data /tmp/viz-ephem \
    && chown -R viz:viz /data /tmp/viz-ephem

USER 10001:10001
EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8501/healthz', timeout=3)" || exit 1

ENTRYPOINT ["python", "server.py", "--mode", "web", "--no-auto-hub"]
CMD ["--host", "0.0.0.0", "--port", "8501", "--data-dir", "/data"]
