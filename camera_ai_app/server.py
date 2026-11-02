"""Realtime camera AI assistant server.

The phone browser captures camera frames and sends them here together with
the user's question. The server forwards them to an OpenAI vision model and
returns the answer, which the browser displays and reads aloud.
"""

import os
import secrets
from pathlib import Path
from typing import List, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI, RateLimitError
from pydantic import BaseModel, Field

load_dotenv()

# All providers below speak the OpenAI chat API, so only the endpoint,
# key and model differ. Pick one with AI_PROVIDER.
PROVIDERS = {
    # Google Gemini: free tier (no card) at https://aistudio.google.com/apikey
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/",
               "GEMINI_API_KEY", "gemini-2.5-flash"),
    # Ollama: free, runs a vision model on your own PC (e.g. `ollama pull gemma3`)
    "ollama": ("http://localhost:11434/v1", None, "gemma3"),
    # OpenAI: paid
    "openai": (None, "OPENAI_API_KEY", "gpt-4o-mini"),
}
PROVIDER = os.getenv("AI_PROVIDER", "gemini").lower()
if PROVIDER not in PROVIDERS:
    raise SystemExit(f"AI_PROVIDER must be one of {', '.join(PROVIDERS)}")
_base_url, _key_env, _default_model = PROVIDERS[PROVIDER]
BASE_URL = os.getenv("AI_BASE_URL", _base_url)
API_KEY = (os.getenv(_key_env) if _key_env else None) or "not-needed"
MODEL = os.getenv("AI_MODEL", _default_model)
MAX_HISTORY = int(os.getenv("MAX_HISTORY", "10"))
STATIC_DIR = Path(__file__).parent / "static"
# When set, the app asks for this password before calling the AI, so a
# publicly deployed server cannot be used by strangers on your API key.
APP_PASSWORD = os.getenv("APP_PASSWORD", "")

SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT",
    "당신은 사용자의 휴대폰 카메라 화면을 실시간으로 보고 있는 친절한 AI 비서입니다. "
    "함께 전달되는 이미지는 지금 이 순간의 카메라 화면입니다. "
    "보이는 것을 근거로 한국어로 짧고 자연스럽게 대화하듯 답하세요 (보통 1~3문장). "
    "확실하지 않은 것은 추측이라고 말하세요.",
)

AUTO_PROMPT = (
    "지금 카메라에 보이는 것을 한두 문장으로 설명해 주세요. "
    "직전 설명과 거의 같다면 새로 바뀐 점만 짧게 말하세요."
)

client = AsyncOpenAI(base_url=BASE_URL, api_key=API_KEY)
app = FastAPI(title="Camera AI")


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AnalyzeRequest(BaseModel):
    image: str = Field(..., description="data:image/jpeg;base64,... frame")
    message: Optional[str] = None  # None -> automatic scene description
    history: List[Turn] = []


class AnalyzeResponse(BaseModel):
    reply: str


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest,
                  x_app_password: str = Header("")) -> AnalyzeResponse:
    if APP_PASSWORD and not secrets.compare_digest(
            x_app_password.encode(), APP_PASSWORD.encode()):
        raise HTTPException(401, "비밀번호가 틀렸습니다")
    if not req.image.startswith("data:image/"):
        raise HTTPException(400, "image must be a data URL")

    text = (req.message or "").strip() or AUTO_PROMPT
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    # Only text is kept in history; the current frame is the only image sent.
    messages += [t.model_dump() for t in req.history[-MAX_HISTORY:]]
    image = {"url": req.image}
    if PROVIDER == "openai":
        image["detail"] = "low"  # fewer image tokens; not part of other APIs
    messages.append({
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": image},
        ],
    })

    try:
        resp = await client.chat.completions.create(
            model=MODEL, messages=messages, max_tokens=300)
    except RateLimitError as exc:
        raise HTTPException(
            429, "요청이 너무 많습니다 (무료 사용량 한도). 잠시 후 다시 시도하세요.") from exc
    except Exception as exc:  # surface API errors to the phone UI
        raise HTTPException(502, f"AI 호출 실패 ({PROVIDER}): {exc}") from exc
    return AnalyzeResponse(reply=resp.choices[0].message.content or "")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/manifest.webmanifest")
async def manifest() -> FileResponse:
    return FileResponse(STATIC_DIR / "manifest.webmanifest",
                        media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker() -> FileResponse:
    # Served from the root so the service worker controls the whole app.
    return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    cert, key = Path("cert.pem"), Path("key.pem")
    ssl = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)} \
        if cert.exists() and key.exists() else {}
    print(f"https://<PC-IP>:{port}" if ssl else f"http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, **ssl)
