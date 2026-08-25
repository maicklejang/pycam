# 문서 뷰어 — 안드로이드 앱

휴대폰에 설치해 두면 **다운로드한 파일을 눌렀을 때 바로 열리는** 뷰어입니다.
PDF · 워드(docx) · 엑셀(xlsx) · 파워포인트(pptx) · CSV · 그림 · 텍스트를 지원합니다.

## 설치

1. `docviewer.apk` 를 휴대폰으로 옮깁니다(메신저·메일·USB 무엇이든 좋습니다).
2. 파일을 눌러 설치합니다. 처음에는 **"출처를 알 수 없는 앱"** 허용을 물어보므로
   허용해 주세요. (플레이 스토어를 거치지 않은 앱이라 나오는 안내입니다.)
3. 설치 뒤 파일 앱·다운로드 목록에서 문서를 누르면 열기 목록에 **문서 뷰어** 가
   나타납니다. "항상"을 고르면 다음부터는 바로 이 앱으로 열립니다.

## 앱이 하는 일

* 화면은 `docviewer/static` 의 휴대폰용 페이지를 그대로 담은 WebView 입니다.
* 다른 앱이 보낸 `content://` 주소를 액티비티가 읽어 바이트를 넘겨주면, 페이지가
  그 자리에서 zip 을 풀고 XML 을 해석해 그립니다.
* **인터넷 권한이 없습니다.** 문서는 어디로도 전송되지 않고, 네트워크를 쓸 수
  없으니 전송될 방법 자체가 없습니다.
* **PDF 는 안드로이드의 `PdfRenderer` 로 액티비티가 직접 그립니다.** 안드로이드
  WebView 에는 브라우저와 달리 PDF 표시 기능이 없어서, 각 쪽을 이미지로 렌더링해
  화면에 넘깁니다. 쪽 넘기기(좌우로 밀기)와 확대가 됩니다.
* 열지 못한 파일은 이름·크기·형식·안드로이드/WebView 버전을 함께 보여 주고,
  **다른 앱으로 열기** 단추를 제공합니다.
* 뒤로 가기는 문서 → 목록 → 앱 종료 순으로 동작합니다.

## 직접 빌드하기

그래들 없이 표준 SDK 도구만 사용합니다.

```
python3 docviewer/android/build.py --output docviewer.apk
```

필요한 도구:

* JDK 8 이상 (`javac`, `keytool`)
* `aapt`, `zipalign`, `apksigner`, `android.jar`
* dex 변환기 (`d8` 또는 `dx`)

데비안·우분투라면 다음으로 모두 준비됩니다.

```
sudo apt install default-jdk aapt apksigner zipalign android-sdk-platform-23
# 데비안 패키지에는 dex 변환기가 없어 한 번만 내려받습니다
curl -O https://repo.maven.apache.org/maven2/com/jakewharton/android/repackaged/\
dalvik-dx/14.0.0_r21/dalvik-dx-14.0.0_r21.jar
python3 docviewer/android/build.py --dx dalvik-dx-14.0.0_r21.jar
```

안드로이드 스튜디오의 SDK 를 쓴다면 `ANDROID_HOME` 만 설정되어 있으면 됩니다.
기본 서명 키는 안드로이드 디버그 키스토어이며, 배포용 키가 있다면
`--keystore`, `--key-alias`, `--keystore-pass` 로 지정합니다.

## 구성

```
android/
├── AndroidManifest.xml    인텐트 필터(어떤 형식을 열 수 있다고 알릴지)
├── build.py               javac → dx → aapt → zipalign → apksigner
├── res/                   앱 이름과 아이콘 (아이콘은 docviewer/icons.py 가 생성)
└── src/.../MainActivity.java   WebView, 인텐트 처리, 자바스크립트 다리
```

## 한계

* `.doc .xls .ppt .hwp` 같은 구형 형식은 열지 못합니다. 최신 형식으로 저장해 주세요.
* 64MB 가 넘는 파일은 거절합니다.
* 암호가 걸린 PDF 는 열지 못합니다. 이때는 **다른 앱으로 열기** 로 넘길 수 있습니다.
* 오래된 안드로이드 WebView(크롬 80 미만)에는 브라우저 내장 압축 해제가 없어,
  뷰어가 자체 deflate 해제기로 처리합니다. 조금 느릴 뿐 결과는 같습니다.
