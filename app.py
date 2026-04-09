import io
from flask import Flask, render_template, request, jsonify, send_file
from config import Config
from converter import convert_to_rdf

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
        rdf = convert_to_rdf(pdf_bytes)
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 422
    except RuntimeError as e:
        return jsonify({"status": "error", "message": str(e)}), 502

    return jsonify({"status": "ok", "rdf": rdf})


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
