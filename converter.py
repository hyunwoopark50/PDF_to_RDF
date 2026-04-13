import fitz  # pymupdf
import logging
import time
from openai import OpenAI
from config import Config
from prompts import EXTRACTION_SYSTEM_PROMPT, CONVERSION_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

client = OpenAI(api_key=Config.OPENAI_API_KEY)


def _extract_page_text_columnar(page) -> str:
    """다단(multi-column) 레이아웃을 열 순서대로 읽어 텍스트 반환."""
    blocks = page.get_text("blocks")  # (x0, y0, x1, y1, text, block_no, block_type)
    text_blocks = [b for b in blocks if b[6] == 0 and b[4].strip()]  # type 0 = text

    if not text_blocks:
        return ""

    # 페이지 너비를 기준으로 좌/우 열 구분 (중앙 기준)
    page_width = page.rect.width
    mid = page_width / 2

    left_col  = sorted([b for b in text_blocks if b[0] < mid], key=lambda b: (b[1], b[0]))
    right_col = sorted([b for b in text_blocks if b[0] >= mid], key=lambda b: (b[1], b[0]))

    parts = [b[4] for b in left_col] + [b[4] for b in right_col]
    return "\n".join(parts)


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise ValueError(f"Could not open PDF: {e}")

    if doc.is_encrypted:
        raise ValueError("PDF is encrypted/password-protected and cannot be processed.")

    pages = []
    for page in doc:
        pages.append(_extract_page_text_columnar(page))
    doc.close()

    full_text = "\n\n--- PAGE BREAK ---\n\n".join(pages).strip()
    if not full_text:
        raise ValueError(
            "No extractable text found. The PDF may be image-only (scanned)."
        )

    if len(full_text) > Config.MAX_TEXT_CHARS:
        full_text = (
            full_text[: Config.MAX_TEXT_CHARS]
            + "\n[TEXT TRUNCATED TO FIT CONTEXT WINDOW]"
        )

    return full_text


def _fix_unescaped_ampersands(xml_str: str) -> str:
    """
    XML attribute값과 텍스트에서 엔터티 참조가 아닌 raw & 를 &amp;로 이스케이프.
    &amp; &lt; &gt; &quot; &apos; &#...; 는 건드리지 않음.
    """
    import re
    return re.sub(r'&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)', '&amp;', xml_str)


def clean_rdf_output(raw: str) -> str:
    """Strip markdown fences, fix unescaped & in XML."""
    raw = raw.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        elif lines[0].strip().startswith("```"):
            lines = lines[1:]
        raw = "\n".join(lines)
    return _fix_unescaped_ampersands(raw.strip())


def _strip_chunk(chunk: str) -> str:
    """Strip markdown fences and trailing </rdf:RDF> from a continuation chunk."""
    chunk = chunk.strip()
    # Remove markdown fences
    if chunk.startswith("```"):
        lines = chunk.split("\n")
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        elif lines[0].strip().startswith("```"):
            lines = lines[1:]
        chunk = "\n".join(lines).strip()
    chunk = _fix_unescaped_ampersands(chunk)
    # Remove trailing </rdf:RDF> so we can append more chunks
    closing = "</rdf:RDF>"
    if chunk.endswith(closing):
        chunk = chunk[: -len(closing)].rstrip()
    return chunk


def _extract_grouping_node_iris(rdf_text: str) -> list[str]:
    """이미 생성된 RDF 텍스트에서 skos:narrower를 가진 grouping node의 doc: IRI를 추출."""
    import re
    # skos:narrower가 하나라도 있는 Concept의 rdf:about 값을 찾음
    concept_blocks = re.findall(
        r'<skos:Concept\s+rdf:about="(doc:[^"]+)"[^>]*>(.*?)</skos:Concept>',
        rdf_text,
        re.DOTALL,
    )
    grouping = []
    for iri, body in concept_blocks:
        if "<skos:narrower" in body:
            grouping.append(iri)
    return grouping


def _validate_rdf_references(rdf_text: str) -> list[str]:
    """skos:broader/narrower로 참조된 IRI가 실제로 정의되어 있는지 확인하고 경고 로그.
    미정의 IRI 목록을 반환한다."""
    import re
    defined = set(re.findall(r'<skos:Concept\s+rdf:about="(doc:[^"]+)"', rdf_text))
    referenced = set(re.findall(r'rdf:resource="(doc:[^"]+)"', rdf_text))
    # ConceptScheme IRI는 제외
    scheme_iris = set(re.findall(r'<skos:ConceptScheme\s+rdf:about="(doc:[^"]+)"', rdf_text))
    undefined = referenced - defined - scheme_iris
    if undefined:
        logger.warning(f"미정의 IRI 참조 감지 ({len(undefined)}개): {', '.join(sorted(undefined))}")
    return sorted(undefined)


def _fix_undefined_iris(rdf_text: str, undefined_iris: list[str], concept_list_str: str) -> str:
    """미정의 IRI에 대한 skos:Concept 블록을 GPT에게 추가 생성 요청."""
    logger.info(f"  └ Undefined IRI fix pass: {', '.join(undefined_iris)}")
    prompt = (
        "The following IRIs are referenced in the RDF via skos:broader or skos:narrower "
        "but have no corresponding skos:Concept definition:\n"
        + "\n".join(f"  - {iri}" for iri in undefined_iris)
        + "\n\nFor each missing IRI, insert a complete skos:Concept block with: "
        "prefLabel (ko + en), at least 2 altLabels, meta:source, skos:broader pointing to its "
        "parent grouping node, and skos:inScheme. "
        "Do NOT remove or change any existing concepts. "
        "Output the complete corrected RDF from <?xml ...> to </rdf:RDF>.\n\n"
        f"Confirmed concept list:\n{concept_list_str}\n\n"
        f"Current RDF:\n{rdf_text}"
    )
    try:
        response = client.chat.completions.create(
            model=Config.GPT_MODEL,
            messages=[
                {"role": "system", "content": CONVERSION_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            temperature=0.1,
            max_tokens=16000,
        )
    except Exception as e:
        logger.error(f"Undefined IRI fix pass 실패: {e}")
        return rdf_text  # 실패 시 원본 반환

    fixed = clean_rdf_output(response.choices[0].message.content)
    logger.info("  └ Undefined IRI fix pass 완료")
    return fixed


def _apply_grouping_correction(
    rdf_text: str, concept_list_str: str
) -> str:
    """
    flat 구조(grouping node 없음)를 감지하면 GPT에 correction pass를 요청한다.
    grouping node를 추가하고 leaf concept의 skos:broader를 재할당한 완전한 RDF를 반환.
    """
    logger.info("  └ Correction pass: flat 구조 감지 → 계층 재구성 요청")
    correction_prompt = (
        "The RDF you generated has a flat structure: every concept points its skos:broader "
        "directly at the top-most root concept, with no thematic grouping nodes in between. "
        "This is wrong.\n\n"
        "Your task:\n"
        "1. Look at the confirmed concept list and identify 2–6 natural thematic clusters "
        "(e.g. by technology type, organization, output type, etc.).\n"
        "2. Create a skos:Concept grouping node for each cluster. "
        "Each grouping node must have: prefLabel, at least 4 altLabels, meta:source, "
        "skos:broader pointing to the root concept, skos:narrower for each member, "
        "and skos:inScheme.\n"
        "3. Update every leaf concept's skos:broader to point to its grouping node, "
        "NOT to the root concept.\n"
        "4. Do NOT create a grouping node with fewer than 2 members.\n"
        "5. Output the complete corrected RDF/XML from <?xml ...> to </rdf:RDF>. "
        "Do not omit any concept. Do not use placeholder comments.\n\n"
        f"Confirmed concept list:\n{concept_list_str}\n\n"
        "Current (flat) RDF to fix:\n"
        f"{rdf_text}"
    )
    try:
        response = client.chat.completions.create(
            model=Config.GPT_MODEL,
            messages=[
                {"role": "system", "content": CONVERSION_SYSTEM_PROMPT},
                {"role": "user", "content": correction_prompt},
            ],
            temperature=0.1,
            max_tokens=16000,
        )
    except Exception as e:
        logger.error(f"Correction pass 실패: {e}")
        return rdf_text  # 실패 시 원본 반환

    corrected = clean_rdf_output(response.choices[0].message.content)
    logger.info("  └ Correction pass 완료")
    return corrected


# ── Pass 1: 개념 추출 ──────────────────────────────────────────────────────────

def extract_concepts(text: str) -> list[str]:
    logger.info("Pass 1 시작: 개념 추출 중...")
    t0 = time.time()
    try:
        response = client.chat.completions.create(
            model=Config.GPT_MODEL,
            messages=[
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {"role": "user", "content": (
                    f"Document text:\n---\n{text}\n---\n\n"
                    "Extract all searchable concepts from this document."
                )},
            ],
            temperature=0.1,
            max_tokens=1500,
        )
    except Exception as e:
        logger.error(f"Pass 1 실패: {e}")
        raise RuntimeError(f"GPT API call failed (Pass 1): {e}")

    raw = response.choices[0].message.content.strip()

    concepts = []
    seen = set()
    for line in raw.splitlines():
        concept = line.strip().lstrip("-•·").strip()
        if concept and concept not in seen:
            concepts.append(concept)
            seen.add(concept)

    elapsed = time.time() - t0
    logger.info(f"Pass 1 완료: {len(concepts)}개 개념 추출 ({elapsed:.1f}s)")
    if len(concepts) < 15:
        logger.warning(f"Pass 1 개념 수 부족: {len(concepts)}개 (기대치 40+)")

    return concepts


# ── Pass 2: RDF 생성 ───────────────────────────────────────────────────────────

def convert_to_rdf(pdf_bytes: bytes, filename: str = "unknown", progress_cb=None) -> str:
    """PDF를 SKOS RDF/XML로 변환한다.
    progress_cb: 진행 단계 메시지를 전달받는 선택적 콜백 함수 (str) → None
    """
    def _progress(msg: str):
        logger.info(msg)
        if progress_cb:
            progress_cb(msg)

    total_start = time.time()
    logger.info("=" * 50)
    logger.info(f"변환 시작: {filename}")
    logger.info("=" * 50)
    _progress(f"Step 1/3: PDF 텍스트 추출 중... ({filename})")

    text = extract_text_from_pdf(pdf_bytes)
    logger.info(f"PDF 텍스트 추출 완료: {len(text):,}자")

    # Pass 1: 개념 목록 추출
    _progress("Step 2/3: 개념 목록 추출 중... (Pass 1)")
    concepts = extract_concepts(text)
    if not concepts:
        logger.error("Pass 1 결과 없음: PDF가 너무 짧거나 읽을 수 없음")
        raise RuntimeError("Pass 1 returned no concepts. PDF may be too short or unreadable.")

    concept_list_str = "\n".join(f"- {c}" for c in concepts)

    # Pass 2: 확정 목록 기반 RDF 생성 (토큰 한계 시 자동 이어쓰기)
    _progress(f"Step 3/3: RDF/XML 생성 중... ({len(concepts)}개 개념, Pass 2)")
    logger.info(f"Pass 2 시작: {len(concepts)}개 개념 → RDF/XML 변환 중...")
    pass2_start = time.time()

    user_message = (
        "Convert the following document text into a SKOS knowledge graph in RDF/XML format.\n"
        "Follow the rules exactly.\n\n"
        f"Document text:\n---\n{text}\n---\n\n"
        f"Confirmed concept list (every item below MUST appear as a skos:Concept):\n"
        f"{concept_list_str}"
    )

    messages = [
        {"role": "system", "content": CONVERSION_SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    full_rdf = ""
    max_continuations = 4
    continuation_count = 0

    for attempt in range(max_continuations + 1):
        try:
            response = client.chat.completions.create(
                model=Config.GPT_MODEL,
                messages=messages,
                temperature=0.1,
                max_tokens=16000,
            )
        except Exception as e:
            logger.error(f"Pass 2 실패 (attempt {attempt + 1}): {e}")
            raise RuntimeError(f"GPT API call failed (Pass 2, attempt {attempt + 1}): {e}")

        chunk = response.choices[0].message.content
        finish_reason = response.choices[0].finish_reason

        # GPT가 placeholder 주석으로 나머지를 생략했는지 감지
        placeholder_patterns = [
            "follow the same pattern",
            "following the same pattern",
            "omitted for brevity",
            "additional concepts",
            "remaining concepts",
            "... more concepts",
            "would follow",
        ]
        has_placeholder = any(p in chunk.lower() for p in placeholder_patterns)

        if finish_reason != "length" and not has_placeholder:
            # 정상 완료: 마크다운 펜스 제거 (attempt 0 포함 항상 적용)
            full_rdf += clean_rdf_output(chunk)
            break

        # 이어쓰기가 필요한 경우: </rdf:RDF>와 마크다운 펜스를 제거하고 붙임
        full_rdf += _strip_chunk(chunk)
        continuation_count += 1

        if attempt == max_continuations:
            full_rdf += "\n</rdf:RDF>"
            logger.warning(f"Pass 2 미완료: {max_continuations + 1}회 시도 후에도 종료되지 않음 (출력 불완전할 수 있음)")
            break

        reason = "placeholder 감지" if has_placeholder else "토큰 한도 초과"
        logger.info(f"  └ Continuation {continuation_count}: {reason} → 이어쓰기 요청")
        _progress(f"Step 3/3: RDF 이어쓰기 중... (continuation {continuation_count}, {reason})")

        # 이어쓰기 요청
        messages.append({"role": "assistant", "content": chunk})
        if has_placeholder:
            messages.append({
                "role": "user",
                "content": (
                    "You used a placeholder comment instead of writing all concepts. "
                    "This is not allowed. Write out EVERY remaining concept from the confirmed list "
                    "as a full skos:Concept entry. Do not use comments like 'follow the same pattern'. "
                    "Continue from the last complete skos:Concept and close with </rdf:RDF> only after all are written."
                ),
            })
        else:
            # 이미 출력된 RDF에서 grouping node (skos:narrower를 가진 개념) IRI 추출
            grouping_nodes = _extract_grouping_node_iris(full_rdf)
            if grouping_nodes:
                hierarchy_hint = (
                    "CRITICAL: Maintain the EXACT same hierarchy already established. "
                    f"The thematic grouping nodes already defined are: {', '.join(grouping_nodes)}. "
                    "Every remaining leaf concept MUST use skos:broader pointing to the correct grouping node among these, "
                    "NOT directly to the top-most institutional concept. "
                    "Do not change any broader assignments already written. "
                )
            else:
                hierarchy_hint = (
                    "CRITICAL: Maintain the EXACT same hierarchy already established. "
                    "Use skos:broader pointing to the correct thematic grouping node already defined, "
                    "NOT directly to the top-most institutional concept. "
                )
            messages.append({
                "role": "user",
                "content": (
                    "The output was cut off. Continue the RDF/XML exactly from where you left off. "
                    "Do not repeat any skos:Concept entries already written. "
                    + hierarchy_hint +
                    "Continue until ALL concepts in the confirmed list have been written, "
                    "then close with </rdf:RDF>."
                ),
            })

    pass2_elapsed = time.time() - pass2_start
    total_elapsed = time.time() - total_start

    cleaned = clean_rdf_output(full_rdf)

    # flat 구조 감지: grouping node(skos:narrower를 가진 Concept)가 없으면 correction pass
    if not _extract_grouping_node_iris(cleaned):
        logger.warning("Pass 2 결과 flat 구조 감지: grouping node 없음 → correction pass 시작")
        cleaned = _apply_grouping_correction(cleaned, concept_list_str)

    undefined = _validate_rdf_references(cleaned)
    if undefined:
        logger.warning(f"미정의 IRI {len(undefined)}개 감지 → 자동 수정 패스 시작")
        _progress(f"Step 3/3: 미정의 IRI {len(undefined)}개 자동 수정 중...")
        cleaned = _fix_undefined_iris(cleaned, undefined, concept_list_str)
        # 수정 후 재검증
        still_undefined = _validate_rdf_references(cleaned)
        if still_undefined:
            logger.warning(f"자동 수정 후에도 미정의 IRI 잔존: {', '.join(still_undefined)}")

    logger.info(f"Pass 2 완료: {pass2_elapsed:.1f}s (continuation {continuation_count}회)")
    logger.info(f"변환 완료: {filename} | 총 소요 {total_elapsed:.1f}s")
    logger.info("=" * 50)

    return cleaned


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python converter.py <path_to_pdf>")
        sys.exit(1)
    with open(sys.argv[1], "rb") as f:
        print(convert_to_rdf(f.read()))
