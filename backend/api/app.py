import logging

from flask import Flask
from flask_cors import CORS

from backend.api.routes import api
from backend.config import config


def create_app() -> Flask:
    logging.basicConfig(level=logging.INFO)
    app = Flask(__name__)
    # The extension calls us from youtube.com pages and its own service worker.
    CORS(app, origins=["https://www.youtube.com", "chrome-extension://*"])
    app.register_blueprint(api)
    return app


def main() -> None:
    create_app().run(host="127.0.0.1", port=config.port, debug=config.flask_debug)


if __name__ == "__main__":
    main()
