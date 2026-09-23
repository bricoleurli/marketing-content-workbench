FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY . /app

ENV WORKBENCH_HOST=0.0.0.0 \
    WORKBENCH_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]
EXPOSE 8765
CMD ["python", "server.py"]
