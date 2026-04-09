import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
    SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-insecure-default")
    DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    MAX_PDF_SIZE_BYTES = int(os.environ.get("MAX_PDF_SIZE_MB", 20)) * 1024 * 1024
    GPT_MODEL = os.environ.get("GPT_MODEL", "gpt-4o")
    MAX_TEXT_CHARS = 48000  # ~12k tokens, safe for gpt-4o with prompt overhead
    PORT = int(os.environ.get("PORT", 5400))
    SAVEFILE_DIR = os.path.join(os.path.dirname(__file__), "savefile")
