import logging

from flask import Flask
from flask_cors import CORS

from backend.api.routes import api
from backend.community_votes import community_votes_api
from backend.config import config
from backend.database import run_migrations


def create_app() -> Flask:
    logging.basicConfig(level=logging.INFO)
    run_migrations()
    app = Flask(__name__)
    # The extension calls us from youtube.com pages and its own service worker.
    _ = CORS(app, origins=["https://www.youtube.com", "chrome-extension://*"])
    app.register_blueprint(api)
    app.register_blueprint(community_votes_api)
    return app


def main() -> None:
    create_app().run(host=config.host, port=config.port, debug=config.flask_debug)


if __name__ == "__main__":
    main()
