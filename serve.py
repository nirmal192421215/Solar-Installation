"""Local server for the demo: python serve.py, then open http://localhost:8080/

Same as `python -m http.server 8080`, but it doesn't refuse connections when a page loads many files at once
(the built-in server queues only 5, so a script can occasionally fail to load).
"""
import functools
import http.server
import os


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.dirname(os.path.abspath(__file__)))
print("Sun Power demo: http://localhost:8080/ (website) · /admin/ (CRM) · /portal/ (Localhost users). Ctrl+C to stop.")
Server(("127.0.0.1", 8080), handler).serve_forever()
