# 📷 Camera AI – 휴대폰 카메라 실시간 AI 대화 앱

휴대폰 카메라로 비추면 AI(OpenAI 비전 모델)가 화면을 분석하고, 음성/텍스트로 대화할 수 있는 앱입니다.

```
[휴대폰 브라우저]  카메라 프레임 + 질문  ──▶  [Python 서버 (FastAPI)]  ──▶  OpenAI API
      ▲  음성 인식(STT) / 음성 출력(TTS)                     │
      └──────────────────── AI 답변 ◀───────────────────────┘
```

- **설치형 웹앱(PWA)**: 앱스토어 없이 홈 화면에 설치 → 아이콘으로 실행, 전체 화면 앱처럼 동작
  (Android·iPhone 모두 지원, 설치하지 않고 브라우저에서 바로 써도 됨)
- **자동분석 모드**: 6초마다 화면을 보고 무엇이 보이는지 말해 줌
- **대화**: 🎤 버튼으로 말하거나 글자로 입력 → 현재 화면을 보고 답변, 음성으로 읽어 줌
- 전/후면 카메라 전환, 이전 대화 맥락 유지

## 실행 방법

```bash
cd camera_ai_app
pip install -r requirements.txt
cp .env.example .env        # .env 파일에 OPENAI_API_KEY 입력
./make_cert.sh              # HTTPS 인증서 생성 (휴대폰 카메라는 HTTPS에서만 동작)
python server.py
```

1. PC와 휴대폰을 **같은 Wi-Fi**에 연결
2. PC의 IP 확인 (Windows: `ipconfig`, Mac/Linux: `ifconfig`) → 예: `192.168.0.10`
3. 휴대폰 브라우저에서 `https://192.168.0.10:8000` 접속
4. "안전하지 않음" 경고 → **고급 → 계속 진행** (직접 만든 인증서라서 뜨는 경고)
5. **시작하기** → 카메라 권한 허용

> 인증서 경고가 번거로우면 `cloudflared tunnel --url http://localhost:8000` 또는 `ngrok http 8000`으로
> 정식 HTTPS 주소를 받아서 접속해도 됩니다 (이 경우 `make_cert.sh`는 필요 없음).

## 📲 앱으로 설치하기

앱 설치는 **정식 HTTPS 주소**에서만 됩니다 (직접 만든 인증서 `make_cert.sh`로는 설치 버튼이 안 뜸).
아래 둘 중 하나로 주소를 만드세요.

### 방법 A: 내 PC에서 실행 + 터널 (가장 빠름)
```bash
python server.py                                  # make_cert.sh 없이 실행
cloudflared tunnel --url http://localhost:8000    # https://xxxx.trycloudflare.com 주소가 나옴
```
PC가 켜져 있는 동안만 사용할 수 있습니다.

### 방법 B: 클라우드에 배포 (PC 없이 항상 사용)
1. [Render](https://render.com) 가입 → **New → Blueprint** → 이 저장소 선택
   (`camera_ai_app/render.yaml` 사용. 안 잡히면 **New → Web Service**, Root Directory `camera_ai_app`, Docker 선택)
2. 환경변수 `OPENAI_API_KEY`와 **`APP_PASSWORD`(꼭 설정!)** 입력
3. 배포가 끝나면 `https://camera-ai-xxxx.onrender.com` 같은 주소가 생김

Docker가 되는 곳이면 어디든 배포 가능: `docker build -t camera-ai . && docker run -p 8000:8000 --env-file .env camera-ai`

### 휴대폰에 설치
- **Android (Chrome)**: 주소 접속 → 첫 화면의 **📲 홈 화면에 앱 설치** 버튼 (또는 메뉴 ⋮ → *앱 설치*)
- **iPhone (Safari)**: 주소 접속 → 아래 **공유 버튼(⬆️)** → **홈 화면에 추가**

설치 후 홈 화면의 **Camera AI** 아이콘을 누르면 주소창 없는 전체 화면 앱으로 열립니다.
`APP_PASSWORD`를 설정했다면 처음 한 번 비밀번호를 물어보고 기억합니다.

## 설정 (`.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | – | OpenAI API 키 (필수) |
| `OPENAI_MODEL` | `gpt-4o-mini` | 이미지 입력을 지원하는 모델. 더 정확하게 하려면 `gpt-4o` |
| `SYSTEM_PROMPT` | 한국어 비서 | AI의 역할/말투 |
| `APP_PASSWORD` | (없음) | 설정하면 앱 사용 시 비밀번호 필요. **공개 배포 시 필수** (내 API 키 도용 방지) |
| `MAX_HISTORY` | `10` | 함께 보내는 이전 대화 수 |

## 비용 줄이기

- 프레임은 가로 640px, JPEG로 줄이고 `detail: "low"`로 보내므로 이미지 1장당 토큰이 적습니다.
- 자동분석 간격은 `static/index.html`의 `AUTO_INTERVAL_MS`로 조절합니다.
