# docscan - 카메라 문서 스캐너

카메라로 찍은 문서·종이 사진을 **자동으로 찾아내고, 기울기를 펴고, 그림자를
없앤 뒤 PDF나 이미지로 저장**하는 앱입니다. 스마트폰 스캐너 앱이 하는 일을
파이썬과 OpenCV만으로 처리합니다.

```
사진/카메라  →  문서 외곽선 검출  →  원근 보정(기울기 펴기)  →  조명·색 보정  →  PDF/이미지
```

## 주요 기능

- **문서 자동 검출** — 여러 방식(Canny 엣지, 형태학적 그래디언트, Otsu 이진화,
  채도 기반)을 동시에 시도하고, 실제 이미지 그래디언트로 네 변이 모두 진짜
  경계인지 검증해서 가장 좋은 후보를 고릅니다. 페이지 안의 사진·표를 문서로
  착각하지 않습니다.
- **정확한 비율 복원** — 비스듬히 찍은 사각형의 원근 왜곡에서 카메라 초점거리를
  역산해 **원래 종이의 가로:세로 비율**을 복원합니다(A4를 45도로 찍어도 A4 비율로
  펴집니다). `--aspect a4`처럼 용지를 직접 지정할 수도 있습니다.
- **조명·그림자 제거** — 책상 스탠드 때문에 한쪽이 어두운 사진도 균일한 흰
  배경으로 만듭니다.
- **5가지 색 모드** — `color`, `magic`, `gray`, `bw`, `none`.
- **PDF 저장** — 외부 PDF 라이브러리 없이 직접 생성합니다. 흑백(`bw`) 페이지는
  1비트 무손실로 저장되어 파일이 매우 작습니다(같은 페이지 기준 JPEG의 1/20 수준).
- **실시간 카메라 UI** — 미리보기에 검출된 외곽선을 표시하고, 문서를 가만히
  들고 있으면 자동으로 촬영하는 기능, 여러 장 연속 촬영, 실행 취소를 지원합니다.
- **한글 경로 지원** — 파일 이름과 PDF 제목에 한글을 써도 깨지지 않습니다.

## 폰에서 쓰기 (설치형 웹앱)

폰에 설치해서 쓰려면 [`web/`](web/README.md)의 웹앱을 쓰세요. 브라우저로 열고
**홈 화면에 추가**하면 아이콘이 생기고 앱처럼 실행됩니다(안드로이드·아이폰 모두).
검출·보정·PDF 알고리즘은 아래 명령줄 버전과 동일하며, OpenCV.js로 폰 안에서
처리합니다. 사진은 어디로도 전송되지 않습니다.

## 설치 (명령줄)

저장소 최상위 폴더에서 설치하면 `docscan` 명령이 생깁니다.

```bash
pip install ./docscan
docscan --version
```

명령줄 도구만 쓸 거라면 `pipx`로 설치하는 편이 깔끔합니다(시스템 파이썬을
건드리지 않고 독립 환경에 설치되며, 제거는 `pipx uninstall docscan`).

```bash
pipx install ./docscan
```

개발 중이라 코드 수정이 바로 반영되길 원하면:

```bash
pip install -e ./docscan
```

**디스플레이가 없는 서버·컨테이너**라면 창을 띄우지 않는 OpenCV를 직접 설치한
뒤 의존성 없이 추가하세요. 이 경우 `docscan scan`과
`docscan camera --no-preview`를 쓸 수 있습니다.

```bash
pip install numpy opencv-python-headless
pip install ./docscan --no-deps
```

설치하지 않고 저장소에서 바로 실행할 수도 있습니다.

```bash
pip install -r docscan/requirements.txt
python3 -m docscan --help
```

## 사용법

설치했다면 `docscan ...`, 설치하지 않았다면 저장소 최상위에서
`python3 -m docscan ...` 로 실행합니다. 아래 예시는 설치한 경우를 기준으로 합니다.

```bash
docscan --help
```

### 1. 카메라로 스캔하기

```bash
# 미리보기 창을 띄우고 여러 장 촬영 → scans/scan-<날짜>.pdf 로 저장
docscan camera

# 흑백 모드로, 문서를 가만히 들면 자동 촬영, 결과를 지정한 PDF로 저장
docscan camera --mode bw --auto -o 회의록.pdf

# 사진 한 장만 빠르게 찍기
docscan shot -o 영수증.pdf

# 연결된 카메라 확인
docscan devices
```

미리보기 창에서 쓰는 키 (OpenCV 창은 한글을 그리지 못해 안내는 영문입니다):

| 키 | 동작 |
| --- | --- |
| `SPACE` / `Enter` | 현재 화면을 한 페이지로 촬영 |
| `A` | 자동 촬영 켜기/끄기 (문서를 가만히 들고 있으면 자동으로 찍음) |
| `M` | 색 모드 변경 |
| `R` | 90도 회전 |
| `U` | 마지막 페이지 취소 |
| `S` | 저장하고 종료 |
| `Q` / `Esc` | 저장하지 않고 종료 |

외곽선 색의 의미: **초록** = 잘 검출됨, **노랑** = 자동 촬영 직전(안정화 중),
**주황** = 문서가 화면 밖으로 나감(조금 뒤로 물러나세요).

휴대폰을 웹캠처럼 쓰고 싶다면 IP 웹캠 앱의 주소를 그대로 넘기면 됩니다.

```bash
docscan camera --device http://192.168.0.10:8080/video
```

### 2. 이미 찍어둔 사진 스캔하기

```bash
# 폴더 안의 모든 사진을 한 개의 PDF로
docscan scan ./사진 -o 스캔결과.pdf

# 사진 한 장을 흑백 PNG로 (원본 옆에 <이름>_scan.png 생성)
docscan scan 문서.jpg --mode bw --format png

# 폴더를 재귀적으로 훑어 이미지 + PDF를 함께 저장
docscan scan ./사진 -r -o ./결과 --pdf 전체.pdf

# 검출 결과를 눈으로 확인하고 싶을 때(외곽선을 그린 사진을 함께 저장)
docscan scan 문서.jpg -o out.pdf --debug-dir ./debug -v
```

### 색 모드

| 모드 | 설명 | 추천 용도 |
| --- | --- | --- |
| `color` | 조명을 고르게 펴고 흰 배경을 살린 자연스러운 컬러 | 일반 문서, 컬러 자료 |
| `magic` | 대비·채도를 끌어올린 전형적인 스캐너 앱 느낌 | 흐릿한 사진, 형광펜 필기 |
| `gray` | 회색조 | 인쇄용, 용량 절약 |
| `bw` | 순수 흑백(적응형 이진화) | 글자만 있는 문서, 가장 작은 파일 |
| `none` | 보정 없이 기울기만 보정 | 사진·도면 원본 유지 |

```bash
docscan modes   # 설명 보기
```

> 글자가 아주 작게 찍힌 사진(결과에서 글자 높이가 8픽셀 미만)이라면 `bw`보다
> `gray`나 `color`가 읽기 좋습니다. 카메라를 조금 더 가까이 대거나 해상도를
> 높이면 `bw`도 깨끗하게 나옵니다.

### 자주 쓰는 옵션

| 옵션 | 설명 |
| --- | --- |
| `-m, --mode` | 색 모드 (위 표 참고) |
| `-a, --aspect` | 비율 복원 방식: `auto`(기본), `projective`, `edges`, `a4`, `letter` 등 |
| `--margin` | 검출된 외곽선을 넓히거나(양수) 줄임(음수). 기본값은 배경 테두리가 남지 않도록 살짝 안쪽 |
| `--shadow` | 그림자 제거 강도 (0~1, 기본 1) |
| `--sharpen` | 추가 선명화 (예: `0.5`) |
| `--rotate` | 결과를 90/180/270도 회전 |
| `--no-crop` | 문서 검출·자르기를 하지 않고 보정만 수행 |
| `--min-area` | 문서로 인정할 최소 면적 비율 (기본 0.08) |
| `--max-side` | 결과 이미지의 긴 변 최대 픽셀 수 |
| `--dpi` | PDF에 기록할 해상도 (기본 300) |
| `--page-size` | PDF 용지 크기: `auto`(이미지 크기 그대로) 또는 `a4`, `letter` 등 |
| `--quality` | JPEG/WebP 품질 (1~100) |
| `--overwrite` | 같은 이름이 있을 때 덮어쓰기 (기본은 `-2`를 붙여 새 파일 생성) |

## 잘 찍는 요령

- 바탕과 종이의 **색이 다른 곳**에 두세요(흰 종이 → 어두운 책상).
- 종이 네 변이 **모두 화면 안에** 들어오게 찍으세요. 잘리면 미리보기 외곽선이
  주황색으로 바뀝니다.
- 한쪽만 밝은 조명도 괜찮습니다. 그림자 제거가 처리합니다.
- 검출이 실패하면 `--no-crop`으로 보정만 하거나, `--min-area`를 낮춰 보세요.

## 라이브러리로 쓰기

```python
import cv2
from docscan import ScanOptions, scan_image, write_pdf

photo = cv2.imread("문서.jpg")
result = scan_image(photo, ScanOptions(mode="bw", aspect="a4"))

print(result.cropped, result.size, result.detection.method)
write_pdf("문서.pdf", [result.image], dpi=300, title="문서")
```

주요 함수:

| 이름 | 설명 |
| --- | --- |
| `docscan.find_document(image)` | 문서 외곽선(네 꼭짓점) 검출 |
| `docscan.four_point_transform(image, quad)` | 원근 보정 |
| `docscan.enhance(image, mode)` | 색·조명 보정 |
| `docscan.scan_image(image, options)` | 위 과정을 한 번에 수행 |
| `docscan.write_pdf(path, images)` | 여러 페이지를 PDF로 저장 |
| `docscan.CameraScanner` | 실시간 촬영 세션 |

## 구성

| 파일 | 역할 |
| --- | --- |
| `detect.py` | 문서 외곽선 검출과 후보 평가 |
| `transform.py` | 꼭짓점 정렬, 비율 복원, 원근 보정 |
| `enhance.py` | 그림자 제거, 색 모드, 선명화 |
| `pdf.py` | 의존성 없는 PDF 작성기 |
| `camera.py` | 실시간 카메라 세션 |
| `scanner.py` | 전체 파이프라인 |
| `cli.py` | 명령줄 인터페이스 |
| `pyproject.toml` | 독립 패키지 정의 (`pip install ./docscan` → `docscan` 명령) |
| `io_utils.py` | 한글 경로를 지원하는 파일 입출력 |
| `tests/` | 합성 문서 사진으로 하는 자동 테스트 |
| `web/` | 폰에 설치하는 웹앱 (같은 알고리즘의 JavaScript 이식) |

## 테스트

```bash
python3 -m unittest discover -s docscan/tests -t .
```

테스트는 가상 카메라로 렌더링한 합성 문서 사진을 사용하므로 실제 카메라나
샘플 이미지가 없어도 실행됩니다. OpenCV가 설치되어 있지 않으면 자동으로
건너뜁니다.

## 라이선스

이 저장소와 동일하게 GNU General Public License v3 이상을 따릅니다.
