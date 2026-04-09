# PDF to SKOS Ontology Converter

PDF 문서를 업로드하면 GPT가 SKOS 키워드 매핑 온톨로지를 RDF/XML 형식으로 자동 생성하는 웹 애플리케이션입니다.  
GraphRAG 등 RAG 시스템의 엔티티 해소(entity resolution) 및 키워드 확장에 사용할 수 있습니다.

---

## 주요 기능

- PDF 업로드 (드래그&드롭 또는 파일 선택)
- 2-pass GPT 변환: 개념 추출 → RDF/XML 생성
- SKOS 계층 구조 자동 생성 (기관 → 테마 그룹 → leaf 개념)
- 우측 Concept 패널에서 altLabel 추가/삭제
- Save / Load / Download 지원 (savefile/ 디렉토리에 저장)
- CodeMirror 기반 RDF/XML 에디터 (직접 수정 가능)

---

## 실행 방법

### 사전 준비

- [OpenAI API 키](https://platform.openai.com/api-keys) 발급

---

### 방법 1 — Docker (권장)

```bash
# 1. 저장소 클론
git clone https://github.com/hyunwoopark50/PDF_to_RDF.git
cd PDF_to_RDF

# 2. 환경 변수 파일 생성
cp .env.example .env
# .env 파일을 열어 OPENAI_API_KEY 입력

# 3. 실행
docker compose up --build

# 4. 브라우저에서 접속
# http://localhost:5400
```

종료:
```bash
docker compose down
```

---

### 방법 2 — 로컬 Python

Python 3.11 이상 필요

```bash
# 1. 저장소 클론
git clone https://github.com/hyunwoopark50/PDF_to_RDF.git
cd PDF_to_RDF

# 2. 가상환경 생성 및 활성화
python -m venv .venv
source .venv/bin/activate      # macOS / Linux
# .venv\Scripts\activate       # Windows

# 3. 의존성 설치
pip install -r requirements.txt

# 4. 환경 변수 파일 생성
cp .env.example .env
# .env 파일을 열어 OPENAI_API_KEY 입력

# 5. 서버 실행
python app.py

# 6. 브라우저에서 접속
# http://localhost:5400
```

---

## 환경 변수 (.env)

| 변수 | 설명 | 기본값 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API 키 (필수) | — |
| `GPT_MODEL` | 사용할 GPT 모델 | `gpt-4o` |
| `MAX_PDF_SIZE_MB` | 업로드 가능한 PDF 최대 크기 (MB) | `20` |
| `PORT` | 서버 포트 | `5400` |
| `FLASK_DEBUG` | 디버그 모드 | `false` |

---

## 사용 방법

### 1. 온톨로지 생성
1. PDF 파일을 드래그&드롭하거나 browse 클릭으로 선택
2. **Generate Ontology** 버튼 클릭
3. 1–3분 후 RDF/XML 결과가 에디터에 표시됨
4. 변환 완료 시 `savefile/` 디렉토리에 자동 저장

### 2. 개념 편집 (우측 패널)
- 개념 이름 클릭 → 에디터가 해당 위치로 스크롤
- 하단 label editor에서 altLabel 추가/삭제 가능
- Search 창으로 개념 필터링

### 3. 저장 / 불러오기
- **Save**: 현재 파일 덮어쓰기 (처음 저장 시 타임스탬프 파일명 생성)
- **Load**: 저장된 파일 목록에서 선택하여 불러오기
  - 미저장 내용이 있으면 저장 여부 확인 팝업 표시
- **New Conversion**: 새 변환 시작 (미저장 내용 확인)

### 4. 다운로드
- **Download .rdf**: 현재 에디터 내용을 `파일명_타임스탬프.rdf`로 다운로드

---

## 파일 구조

```
PDF_to_RDF/
├── app.py              # Flask 라우트
├── converter.py        # PDF 텍스트 추출 + GPT 2-pass 변환
├── config.py           # 환경 변수 설정
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── .env.example        # 환경 변수 예시
├── savefile/           # 저장된 RDF 파일 (git 제외)
├── static/
│   ├── css/style.css
│   └── js/main.js
└── templates/
    └── index.html
```

---

## 출력 형식

SKOS RDF/XML 형식으로 출력되며 `cbnu:` 네임스페이스를 사용합니다.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:skos="http://www.w3.org/2004/02/skos/core#"
  xmlns:cbnu="http://cbnu.ac.kr/ontology#"
  xmlns:meta="http://example.org/meta#">

  <skos:Concept rdf:about="cbnu:AlienRegistrationCard">
    <skos:prefLabel xml:lang="ko">외국인등록증</skos:prefLabel>
    <skos:altLabel xml:lang="ko">외등증</skos:altLabel>
    <skos:altLabel xml:lang="en">ARC</skos:altLabel>
    <skos:broader rdf:resource="cbnu:행정절차"/>
    <meta:source>guidelines</meta:source>
  </skos:Concept>

</rdf:RDF>
```
