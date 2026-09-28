# 📷 Camera AI – 휴대폰 카메라 실시간 AI 대화 앱

휴대폰 카메라로 비추면 AI(OpenAI 비전 모델)가 화면을 분석하고, 음성/텍스트로 대화할 수 있는 앱입니다.

```
[휴대폰 브라우저]  카메라 프레임 + 질문  ──▶  [Python 서버 (FastAPI)]  ──▶  OpenAI API
      ▲  음성 인식(STT) / 음성 출력(TTS)                     │
      └──────────────────── AI 답변 ◀───────────────────────┘
```

- **앱 설치 불필요**: 휴대폰 브라우저(Chrome, Safari)에서 접속
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

## 설정 (`.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | – | OpenAI API 키 (필수) |
| `OPENAI_MODEL` | `gpt-4o-mini` | 이미지 입력을 지원하는 모델. 더 정확하게 하려면 `gpt-4o` |
| `SYSTEM_PROMPT` | 한국어 비서 | AI의 역할/말투 |
| `MAX_HISTORY` | `10` | 함께 보내는 이전 대화 수 |

## 비용 줄이기

- 프레임은 가로 640px, JPEG로 줄이고 `detail: "low"`로 보내므로 이미지 1장당 토큰이 적습니다.
- 자동분석 간격은 `static/index.html`의 `AUTO_INTERVAL_MS`로 조절합니다.
