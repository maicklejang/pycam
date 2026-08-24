# docviewer — PDF · 워드 · 엑셀 · 파워포인트 · 그림 뷰어

문서를 하나씩 열어보는 작은 앱입니다. 파이썬 표준 라이브러리만 사용하므로 따로
설치할 패키지가 없고, 브라우저 화면으로 결과를 보여 줍니다.

```
python3 -m docviewer                 # 현재 폴더를 엽니다
python3 -m docviewer ~/문서          # 특정 폴더를 엽니다
python3 -m docviewer 보고서.docx      # 특정 파일을 바로 엽니다
python3 -m docviewer --samples /tmp/예제   # 형식별 예제를 만들어 열어봅니다
```

실행하면 기본 브라우저가 `http://127.0.0.1:8800/` 로 열립니다.

## 지원 형식

| 종류 | 확장자 | 표시 방법 |
| --- | --- | --- |
| PDF | `.pdf` | 브라우저 기본 PDF 뷰어에 그대로 표시 (페이지 이동·검색·인쇄 가능) |
| 그림 | `.png .jpg .jpeg .gif .bmp .webp .svg .ico .avif` | 확대/축소·회전·화면 맞춤 |
| 워드 | `.docx .docm` | 제목·굵게·기울임·목록·표·그림·하이퍼링크를 HTML 로 재현 |
| 엑셀 | `.xlsx .xlsm` | 시트 탭, 행/열 머리글, 병합 셀, 날짜·백분율 서식 |
| 표 | `.csv .tsv` | 구분자를 자동으로 감지해 표로 표시 (UTF-8 / CP949) |
| 파워포인트 | `.pptx .pptm` | 슬라이드 원래 위치대로 배치, 축소판 목록, 발표자 노트 |
| 텍스트 | `.txt .md .json .xml .py .ngc .gcode` 등 | 글자 크기 조절이 되는 원문 보기 |
| 구형 문서 | `.doc .xls .ppt .rtf .odt .ods .odp .hwp` | LibreOffice 가 설치되어 있으면 자동 변환해 표시 |

`.doc` 같은 구형 형식은 형식 자체가 공개 규격이 아니어서 LibreOffice(`soffice`)가
있을 때만 열립니다. 없으면 "LibreOffice 가 필요합니다"라고 안내하고, 원본을
내려받을 수 있는 단추를 보여 줍니다. 변환 결과는 임시 폴더에 저장해 두므로 같은
파일을 다시 열 때는 변환을 반복하지 않습니다.

## 화면 사용법

* 왼쪽 목록에서 폴더를 오가며 파일을 선택합니다. `/` 를 누르면 검색창으로 갑니다.
* `j` / `k` 로 다음·이전 파일, 슬라이드에서는 `←` `→` 로 장을 넘깁니다.
* `+` / `-` 로 확대·축소하고, 오른쪽 위 🌙 단추로 어두운 화면으로 바꿉니다.
* "저장" 은 원본 파일 내려받기, "새 창" 은 브라우저에서 원본 열기입니다.

## 명령행 옵션

| 옵션 | 설명 |
| --- | --- |
| `--port 8800` | 포트 지정. 이미 쓰는 중이면 빈 포트를 자동으로 고릅니다. |
| `--host 127.0.0.1` | 바인딩 주소. 기본값은 이 컴퓨터에서만 접속할 수 있는 주소입니다. |
| `--no-browser` | 브라우저를 자동으로 열지 않습니다. |
| `--show-hidden` | 숨김 파일도 목록에 표시합니다. |
| `--allow-any-host` | localhost 외의 호스트 이름으로 접속하는 것을 허용합니다. |
| `--samples DIR` | 형식별 예제 파일을 만들고 그 폴더를 엽니다. |

## 안전 장치

* 지정한 폴더(루트) 밖의 파일은 열 수 없습니다. `..` 나 절대 경로는 모두 루트
  안으로 제한합니다.
* 기본값은 루프백 주소 바인딩이며, 다른 호스트 이름으로 들어온 요청은 거절합니다
  (DNS 재바인딩 차단). 필요하면 `--allow-any-host` 로 끌 수 있습니다.
* 문서에서 뽑아낸 글자는 모두 이스케이프한 뒤 화면에 넣으므로 문서 안의 스크립트가
  실행되지 않습니다. 문서 안 그림은 이미지 확장자를 가진 파트만 내보냅니다.

## 구조

```
docviewer/
├── __main__.py      명령행 진입점
├── server.py        HTTP 서버와 API (/api/browse, /api/document, /api/media, /file)
├── documents.py     파일 종류별 렌더러 연결, 문서 속성 읽기
├── filetypes.py     확장자 → 종류/MIME 표
├── convert.py       구형 형식을 LibreOffice 로 변환 (선택 사항)
├── render/          docx·xlsx·pptx 파서 (zipfile + ElementTree 만 사용)
├── samples.py       형식별 예제 파일 생성기
├── static/          화면 (index.html, style.css, app.js)
└── tests/           단위 테스트와 HTTP 통합 테스트
```

## 테스트

```
python3 -m unittest discover -s docviewer/tests -t .
```
