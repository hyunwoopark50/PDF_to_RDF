import fitz  # pymupdf
import logging
import time
from openai import OpenAI
from config import Config

logger = logging.getLogger(__name__)

client = OpenAI(api_key=Config.OPENAI_API_KEY)

# ── Pass 1: 개념 추출 프롬프트 ─────────────────────────────────────────────────

EXTRACTION_SYSTEM_PROMPT = """You are a concept extractor specializing in document analysis.
Your sole task is to read a document and list every specific named concept
that a user might search for when asking questions about this document.

OUTPUT FORMAT:
- One concept per line
- No XML, no JSON, no numbers, no bullet points, no explanation
- No preamble, no closing remarks — just the list

INCLUDE these types (only if actually present in the document):
  - Organization / office names
  - Online portals and information systems (URLs, system names)
  - Specific document names (certificates, forms, cards)
  - Exam and language test names
  - Program and service names
  - Financial items (fees, scholarships, insurance types)
  - Visa types and legal statuses
  - Academic policies and events (warnings, leave, graduation)
  - Procedures with a named outcome (registration, extension)

EXCLUDE these types:
  - Section or chapter headings (e.g. "안내", "개요", "절차", "소개")
  - Generic verbs or actions ("신청하다", "제출하다")
  - Adjectives or qualitative descriptions

QUANTITY:
  A typical guidebook yields 40–60 concepts.
  More is always better than fewer.
  If you find 70+, list them all."""

# ── Pass 2: RDF 변환 프롬프트 ──────────────────────────────────────────────────

CONVERSION_SYSTEM_PROMPT = """You are an expert knowledge engineer specializing in SKOS (Simple Knowledge Organization System) and RDF.
Your task is to convert a confirmed concept list into a SKOS keyword mapping ontology in RDF/XML format.

PURPOSE: This ontology will be used for entity resolution and keyword expansion in a guideline-based RAG system.
The ontology must answer one critical question per concept:
  "What are ALL the ways a user might refer to this concept in a question?" → skos:altLabel (exhaustive)

═══════════════════════════════════════
RULE 1 — INSTITUTIONAL HIERARCHY FIRST
═══════════════════════════════════════
Always begin with a top-level institutional concept hierarchy derived from the document.
Identify: the issuing organization → sub-organization → support center (if present).
These become the root concepts that all other concepts are linked under via skos:broader.
Example structure:
  충북대학교 → 국제교류본부 → 유학생지원센터 → (grouping nodes) → (leaf concepts)
  (IRI example: doc:충북대학교, doc:유학생지원센터, doc:행정절차, doc:AlienRegistrationCard)

═══════════════════════════════════════
RULE 1-B — THEMATIC GROUPING (INDUCTIVE)
═══════════════════════════════════════
After the institutional hierarchy, examine the CONFIRMED CONCEPT LIST and group
concepts into thematic clusters by asking: "Which of these naturally belong together?"

HOW TO FIND CLUSTERS:
  Look at the concept list and identify natural groupings.
  Use the following names EXACTLY when the corresponding cluster exists in the document.
  Do NOT use section heading style names like "학사 안내", "생활 안내", "체류 및 출입국 업무 안내":
    - 행정절차 — use this name if concepts relate to visa, registration, address change, part-time work
    - 보험 — use this name if concepts relate to insurance types
    - 학사 — use this name if concepts relate to courses, grades, graduation, certificates, student ID
    - 생활 — use this name if concepts relate to housing, student programs, associations
    - 포털/시스템 — use this name if concepts relate to online platforms, information systems
  If the document contains a cluster not listed above, name it with a short noun (e.g. "장학금", "취업").
  Do NOT invent a cluster that has no corresponding concepts in the confirmed list.

RULES FOR GROUPING NODES (MANDATORY — skipping this is a critical error):
  - You MUST create a skos:Concept grouping node for EACH cluster you identify
  - A flat structure where all concepts point directly to the institutional node is WRONG
  - Do NOT create a grouping node if fewer than 2 concepts belong to it
  - Each grouping node: skos:broader → institutional parent above it
  - Each member concept: skos:broader → its grouping node
  - Grouping nodes themselves need altLabels (minimum 4) like any other concept

═══════════════════════════════════════
RULE 2 — CONVERT EVERY CONCEPT — NO SKIPPING
═══════════════════════════════════════
The concept list provided has been pre-confirmed from the document.
EVERY concept in the list MUST appear as a skos:Concept entry.
Skipping any concept is a critical error.

For each concept, determine its correct grouping node parent based on RULE 1-B.
If a concept does not fit any cluster, attach it directly under the nearest institutional node.

═══════════════════════════════════════
RULE 3 — altLabel: MINIMUM 6, TARGET 8–10
═══════════════════════════════════════
Every concept MUST have at least 6 skos:altLabel entries. Target 8–10.

CRITICAL — altLabel must be alternative NAMES or TERMS, never procedural descriptions.
  Bad altLabels (procedural — do NOT use):
    "학생증 발급 절차", "수강신청 방법", "등록 신청 서류", "how to apply"
  Good altLabels (names/synonyms/question keywords):
    "학생증", "농협카드", "공카드", "NH Bank card", "학생 신분증"

Include ALL of the following variant types:
  1. Official full name (if different from prefLabel)
  2. Abbreviated/shortened form (e.g. 외등증, ARC, ID card)
  3. Colloquial/informal name (e.g. 건보, "health card")
  4. Cross-language equivalent (Korean ↔ English)
  5. Abbreviation or acronym in either language
  6. Related administrative term
  7. Common question-form keyword a user would type (e.g. "보험료", "비자 연장")
  8. Any other surface form a user might type

SELF-CHECK before closing each skos:Concept:
  Count your altLabel entries. If fewer than 6 — add more before proceeding.
  If any altLabel describes a procedure or action — replace with a noun/name form.

═══════════════════════════════════════
RULE 4 — meta:source IS ALWAYS "guidelines"
═══════════════════════════════════════
Set <meta:source>guidelines</meta:source> on every concept without exception.
This tool converts guideline documents, so all content routes to the guidelines source.

═══════════════════════════════════════
RULE 5 — LANGUAGE DETECTION
═══════════════════════════════════════
Detect the primary language of the document before generating output.
- If the document is primarily Korean: use xml:lang="ko" for prefLabel; add English variants as altLabel
- If the document is primarily English: use xml:lang="en" for prefLabel; add Korean variants as altLabel where natural
- If the document is bilingual: use the dominant language for prefLabel, the other for cross-language altLabel
- For rdf:about CamelCase IDs: use English transliteration for Korean concepts (e.g. doc:AlienRegistrationCard),
  or direct English for English concepts (e.g. doc:StudentVisa)
- Always include both-language variants in altLabel regardless of document language

═══════════════════════════════════════
RULE 6 — COMPLETENESS SELF-CHECK
═══════════════════════════════════════
Before closing </rdf:RDF>, verify ALL of the following:
  1. Every concept in the provided concept list has a skos:Concept entry
     → If missing: add it now before closing
  2. Every skos:Concept has at least 6 skos:altLabel entries
     → If under 6: add more now
  3. Every skos:Concept (except the top-most institutional concept) has skos:broader
     → If missing: assign the correct parent now
     → Leaf concepts must point to a grouping node, not directly to the top-most concept
     → Grouping nodes must point to the institutional parent (e.g. 유학생지원센터 or 충북대학교 국제교류본부)
     → A concept with no skos:broader is a critical structural error — fix it before closing
  4. No altLabel describes a procedure — only names and synonyms
     → If found: replace with noun form

═══════════════════════════════════════
OUTPUT RULES
═══════════════════════════════════════
1. Output ONLY valid RDF/XML. No explanation, no markdown fences, no prose.
   NEVER write placeholder comments such as:
     "<!-- Additional concepts follow the same pattern -->"
     "<!-- ... more concepts ... -->"
     "<!-- remaining concepts omitted for brevity -->"
   Every concept MUST be written out in full. There are no shortcuts.
2. Always start with exactly this XML declaration and root element:
   <?xml version="1.0" encoding="UTF-8"?>
   <rdf:RDF
     xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:skos="http://www.w3.org/2004/02/skos/core#"
     xmlns:doc="http://example.org/ontology#"
     xmlns:meta="http://example.org/meta#">
3. Create one skos:ConceptScheme as the root container with a name derived from the document title.
4. For every concept, create a skos:Concept with:
   - rdf:about using the doc: prefix shorthand (CamelCase English, no spaces)
     CORRECT:   rdf:about="doc:AlienRegistrationCard"
     CORRECT:   rdf:resource="doc:행정절차"
     CORRECT:   skos:inScheme rdf:resource="doc:GuideScheme"
     WRONG:     rdf:about="http://example.org/ontology#AlienRegistrationCard"
     WRONG:     rdf:resource="http://example.org/ontology#행정절차"
     CRITICAL: NEVER expand the doc: prefix to its full URI in ANY attribute value.
     This applies to ALL rdf:about, rdf:resource, skos:inScheme, skos:broader, skos:narrower, skos:related attributes.
   - skos:prefLabel — the canonical NOUN or noun phrase name of the concept in the document's primary language with appropriate xml:lang.
     Must be a name, not an action or procedure. Bad: "학생증 발급" (action). Good: "학생증" (the thing itself).
   - skos:altLabel — one tag per variant, minimum 6 entries, include cross-language variants (see RULE 3)
   - meta:source — always "guidelines" (see RULE 4)
   - skos:broader — parent concept IRI (omit only for the top-most institutional concept)
   - skos:narrower — child concept IRIs (bidirectional with skos:broader)
   - skos:related — non-hierarchical associations where meaningful
   - skos:inScheme — the ConceptScheme IRI
   - Do NOT include skos:definition
5. Before each PARENT concept, insert a section-header comment:
   <!-- ═══════════════════════════════════════
        [ParentConcept prefLabel] 계층 / Hierarchy
        [ParentConcept] > [Child1]
                        > [Child2]
   ═══════════════════════════════════════ -->
   - Use the prefLabel language (Korean or English) in comments
   - Align ">" characters vertically
   - Only on parent concepts, not leaf concepts
6. Do not fabricate information not present in the document.
7. Close with </rdf:RDF>."""


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


def _validate_rdf_references(rdf_text: str) -> None:
    """skos:broader/narrower로 참조된 IRI가 실제로 정의되어 있는지 확인하고 경고 로그."""
    import re
    defined = set(re.findall(r'<skos:Concept\s+rdf:about="(doc:[^"]+)"', rdf_text))
    referenced = set(re.findall(r'rdf:resource="(doc:[^"]+)"', rdf_text))
    # ConceptScheme IRI는 제외
    scheme_iris = set(re.findall(r'<skos:ConceptScheme\s+rdf:about="(doc:[^"]+)"', rdf_text))
    undefined = referenced - defined - scheme_iris
    if undefined:
        logger.warning(f"미정의 IRI 참조 감지 ({len(undefined)}개): {', '.join(sorted(undefined))}")


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

def convert_to_rdf(pdf_bytes: bytes, filename: str = "unknown") -> str:
    total_start = time.time()
    logger.info("=" * 50)
    logger.info(f"변환 시작: {filename}")
    logger.info("=" * 50)

    text = extract_text_from_pdf(pdf_bytes)
    logger.info(f"PDF 텍스트 추출 완료: {len(text):,}자")

    # Pass 1: 개념 목록 추출
    concepts = extract_concepts(text)
    if not concepts:
        logger.error("Pass 1 결과 없음: PDF가 너무 짧거나 읽을 수 없음")
        raise RuntimeError("Pass 1 returned no concepts. PDF may be too short or unreadable.")

    concept_list_str = "\n".join(f"- {c}" for c in concepts)

    # Pass 2: 확정 목록 기반 RDF 생성 (토큰 한계 시 자동 이어쓰기)
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
            # 정상 완료: 마크다운 펜스만 제거하고 그대로 붙임
            # attempt > 0이면 full_rdf 중간에 붙는 것이므로 chunk 단위로 제거
            full_rdf += clean_rdf_output(chunk) if attempt > 0 else chunk
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

    _validate_rdf_references(cleaned)

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
