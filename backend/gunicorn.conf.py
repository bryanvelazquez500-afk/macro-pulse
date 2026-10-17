"""Production server config:  gunicorn -c gunicorn.conf.py app.main:app

One async worker by default, on purpose: the SEC rate limiter (10 requests/second, per SEC fair-access
rules), the response caches and the macro-sync lock all live inside the process. Each extra worker
multiplies the traffic sent to SEC EDGAR and keeps its own copy of the caches. A single uvicorn worker
already serves many concurrent requests. Raise WEB_CONCURRENCY only together with a lower
IS_SEC_MAX_REQUESTS_PER_SECOND (e.g. 2 workers → 5 each).
"""

import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
workers = int(os.environ.get("WEB_CONCURRENCY", "1"))
worker_class = "uvicorn_worker.UvicornWorker"
# Cold SEC CompanyFacts downloads and Claude narrative calls can take tens of seconds.
timeout = 120
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
