FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5400

CMD ["gunicorn", "--bind", "0.0.0.0:5400", "--timeout", "300", "--workers", "2", "app:app"]
