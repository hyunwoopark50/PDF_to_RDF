import io
import os
import datetime
import logging
from flask import Flask, render_template, request, jsonify, send_file
from config import Config
from converter import convert_to_rdf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y/%m/%d %H:%M:%S",
)

if not Config.OPENAI_API_KEY:
    raise RuntimeError(
        "OPENAI_API_KEY is not set. Copy .env.example to .env and add your API key."
    )

app = Flask(__name__)
app.config["SECRET_KEY"] = Config.SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = Config.MAX_PDF_SIZE_BYTES


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/convert", methods=["POST"])
def convert():
    if "pdf_file" not in request.files:
        return jsonify({"status": "error", "message": "No file uploaded."}), 400

    f = request.files["pdf_file"]
    if f.filename == "":
        return jsonify({"status": "error", "message": "Empty filename."}), 400
    if not f.filename.lower().endswith(".pdf"):
        return jsonify({"status": "error", "message": "File must be a PDF."}), 400

    pdf_bytes = f.read()

    try:
        rdf = convert_to_rdf(pdf_bytes, filename=f.filename)
    except ValueError as e:
        logging.error(f"변환 오류 [{f.filename}]: {e}")
        return jsonify({"status": "error", "message": str(e)}), 422
    except RuntimeError as e:
        logging.error(f"변환 오류 [{f.filename}]: {e}")
        return jsonify({"status": "error", "message": str(e)}), 502

    os.makedirs(Config.SAVEFILE_DIR, exist_ok=True)
    stem = os.path.splitext(f.filename)[0]
    KST = datetime.timezone(datetime.timedelta(hours=9))
    ts = datetime.datetime.now(KST).strftime("%Y%m%d_%H%M%S")
    save_name = f"{stem}_{ts}.rdf"
    save_path = os.path.join(Config.SAVEFILE_DIR, save_name)
    with open(save_path, "w", encoding="utf-8") as out:
        out.write(rdf)
    logging.info(f"RDF 저장 완료: {save_path}")

    return jsonify({"status": "ok", "rdf": rdf, "saved_as": save_name})


@app.route("/download", methods=["POST"])
def download():
    data = request.get_json()
    if not data or "rdf" not in data:
        return jsonify({"status": "error", "message": "No RDF content provided."}), 400

    buf = io.BytesIO(data["rdf"].encode("utf-8"))
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/rdf+xml",
        as_attachment=True,
        download_name="ontology.rdf",
    )


@app.route("/save", methods=["POST"])
def save():
    data = request.get_json()
    if not data or "rdf" not in data:
        return jsonify({"status": "error", "message": "No RDF content provided."}), 400

    filename = data.get("filename", "").strip()
    if filename:
        # Overwrite existing file — sanitize to prevent path traversal
        if "/" in filename or "\\" in filename or ".." in filename:
            return jsonify({"status": "error", "message": "Invalid filename."}), 400
        save_name = filename
    else:
        stem = data.get("stem", "ontology").strip() or "ontology"
        stem = "".join(c for c in stem if c.isalnum() or c in "-_")[:80]
        KST = datetime.timezone(datetime.timedelta(hours=9))
        ts = datetime.datetime.now(KST).strftime("%Y%m%d_%H%M%S")
        save_name = f"{stem}_{ts}.rdf"

    os.makedirs(Config.SAVEFILE_DIR, exist_ok=True)
    save_path = os.path.join(Config.SAVEFILE_DIR, save_name)
    with open(save_path, "w", encoding="utf-8") as out:
        out.write(data["rdf"])
    logging.info(f"수동 저장: {save_path}")

    return jsonify({"status": "ok", "saved_as": save_name})


def _all_save_dirs():
    """Return list of directories that contain saved RDF files."""
    dirs = [Config.SAVEFILE_DIR]
    legacy = os.path.join(os.path.dirname(__file__), "rdf_outputs")
    if os.path.isdir(legacy):
        dirs.append(legacy)
    return dirs


@app.route("/savefiles", methods=["GET"])
def list_savefiles():
    seen = {}
    for d in _all_save_dirs():
        os.makedirs(d, exist_ok=True)
        for f in os.listdir(d):
            if f.endswith(".rdf") and f not in seen:
                seen[f] = d
    files = sorted(seen.keys(), reverse=True)
    return jsonify({"status": "ok", "files": files})


@app.route("/savefiles/<filename>", methods=["GET"])
def load_savefile(filename):
    if "/" in filename or "\\" in filename or ".." in filename:
        return jsonify({"status": "error", "message": "Invalid filename."}), 400
    for d in _all_save_dirs():
        file_path = os.path.join(d, filename)
        if os.path.isfile(file_path):
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            return jsonify({"status": "ok", "rdf": content, "filename": filename})
    return jsonify({"status": "error", "message": "File not found."}), 404


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.errorhandler(413)
def too_large(e):
    max_mb = Config.MAX_PDF_SIZE_BYTES // (1024 * 1024)
    return (
        jsonify({"status": "error", "message": f"File too large. Max size is {max_mb}MB."}),
        413,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=Config.PORT, debug=Config.DEBUG)
