# 명함 스캐너 (BizCard Scanner)

핸드폰 카메라로 명함을 촬영하면 글자를 인식해서 **명함 사진과 주소록 항목을 함께
기기 연락처에 저장/갱신**하는 안드로이드 앱입니다.

- 온디바이스 OCR (Google ML Kit 한국어 모델, **네트워크 불필요**)
- 이름 / 회사 / 부서 / 직함 / 휴대폰 / 전화 / 팩스 / 이메일 / 웹사이트 / 주소 자동 분류
- 저장 전에 모든 항목을 화면에서 수정 가능
- **저장할 때 배경을 잘라내고 명함 영역만 보관** (자동 감지, 끌 수 있음)
- **명함 목록 검색** — 이름·회사·번호·이메일·주소·인식 원문, 초성 검색 지원
- 같은 번호·이메일의 연락처가 이미 있으면 **덮어쓰지 않고 빠진 항목만 추가**
- 촬영한 명함 사진을 연락처 프로필 사진으로 등록 (기존 사진이 없을 때만)
- 스캔 기록 보관, vCard(.vcf) 공유

## 설치 파일(APK) 받기

APK 는 GitHub Actions 에서 빌드됩니다.

1. 저장소의 **Actions → “BizCard Android APK”** 로 이동
2. 최근 성공한 실행을 열고 **Artifacts → `bizcard-scanner-apk`** 다운로드
3. 압축을 풀면 `bizcard-scanner-debug.apk` 가 들어 있습니다
4. 파일을 휴대폰으로 옮긴 뒤 실행 → “출처를 알 수 없는 앱 설치” 를 허용하고 설치

> `bizcard-scanner-debug.apk` 는 디버그 키로 서명되어 있어 그대로 설치할 수 있습니다.
> 스토어 배포용 서명 APK 가 필요하면 아래 “릴리스 서명” 을 참고하세요.

## 직접 빌드하기

필요한 것: JDK 17, Android SDK (compileSdk 34).

```bash
cd android/bizcard
./gradlew testDebugUnitTest    # 명함 파서 단위 테스트
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` 에 `sdk.dir=/path/to/Android/sdk` 를 적어 두거나 `ANDROID_HOME`
환경변수를 설정하면 됩니다.

### 릴리스 서명

`android/bizcard/keystore.properties` 를 만들면 `assembleRelease` 가 서명된 APK 를
만듭니다. (이 파일과 `.jks` 는 `.gitignore` 로 제외되어 있습니다.)

```properties
storeFile=release-keystore.jks
storePassword=****
keyAlias=bizcard
keyPassword=****
```

```bash
keytool -genkeypair -v -keystore release-keystore.jks -alias bizcard \
        -keyalg RSA -keysize 2048 -validity 10000
./gradlew assembleRelease
```

## 사용 흐름

1. **명함 촬영** — 안내선에 명함을 맞추고 촬영합니다. (갤러리의 기존 사진도 사용 가능)
2. **인식·확인** — OCR 결과가 항목별로 채워집니다. 틀린 값은 그 자리에서 고칩니다.
3. **연락처에 저장** — 주소록 권한을 허용하면 저장됩니다.
   - 같은 휴대폰/전화/이메일을 가진 연락처가 있으면 그 연락처에 **빠진 항목만 추가**합니다.
   - 없으면 새 연락처를 만듭니다.
   - 저장 시점에 사진에서 **명함 영역만 잘라내어** 보관하고, 그 이미지를 연락처 사진으로 씁니다.

### 명함 영역만 저장

OCR 이 찾아낸 글자 상자들을 군집으로 묶어 가장 큰 덩어리를 명함으로 보고, 여백을 더한 뒤
명함 비율(85.6:54)에 가깝게 넓혀 잘라냅니다. 배경에서 홀로 잡힌 글자는 군집에서 떨어져 나가
영역을 늘리지 않습니다. 글자가 사진 전체에 퍼져 있어 잘라낼 것이 없거나 감지 결과가
비정상적으로 작으면 원본을 그대로 둡니다.

확인 화면의 **"명함 영역만 저장"** 스위치로 미리보기를 보면서 켜고 끌 수 있습니다(기본 켜짐).
잘라내기는 저장할 때 한 번만 적용되며, 이미 잘린 명함은 다시 잘리지 않습니다.

### 검색

목록 위 검색창에 입력하면 이름·회사·부서·직함·휴대폰·전화·팩스·이메일·웹사이트·주소·메모와
**인식 원문**까지 훑어 걸러냅니다.

| 입력 | 동작 |
| --- | --- |
| `파이캠` | 부분 일치, 대소문자 무시 |
| `01012345678` 또는 `12345678` | 번호에서 구분자를 무시하고 일치 |
| `ㅎㄱㄷ` | 초성 검색 (→ 홍길동) |
| `홍길동 파이캠` | 공백으로 나눈 낱말을 모두 만족하는 명함만 |

## 권한

| 권한 | 용도 |
| --- | --- |
| `CAMERA` | 명함 촬영 |
| `READ_CONTACTS` | 중복 연락처를 찾아 덮어쓰지 않기 위해 |
| `WRITE_CONTACTS` | 연락처 생성 / 항목 추가 |

명함 사진과 인식 결과는 앱 내부 저장소(`filesDir/cards`)에만 저장되며 외부로 전송되지
않습니다. OCR 모델은 APK 에 포함되어 오프라인에서 동작합니다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `BizCardParser.kt` | OCR 텍스트 → 주소록 항목 분류 (안드로이드 비의존, 단위 테스트 대상) |
| `CardCrop.kt` | 글자 상자 군집으로 명함 영역 추정 (안드로이드 비의존, 단위 테스트 대상) |
| `CardSearch.kt` | 목록 검색·초성 매칭 (안드로이드 비의존, 단위 테스트 대상) |
| `BizCard.kt` | 명함 데이터 모델 + vCard 3.0 직렬화 |
| `CardRecognizer.kt` | ML Kit 한국어 텍스트 인식, 블록을 읽기 순서로 재정렬 |
| `ContactWriter.kt` | `ContactsContract` 배치 연산으로 연락처 생성/병합 |
| `CardStore.kt` | 스캔 기록(JSON) 및 이미지 파일 관리 |
| `ImageUtils.kt` | EXIF 보정 축소, 연락처 사진용 JPEG 압축 |
| `CaptureActivity.kt` | CameraX 촬영 화면 |
| `ReviewActivity.kt` | 인식 결과 확인·수정·저장 화면 |
| `MainActivity.kt` | 스캔 기록 목록 |

## 한계

- 세로로 흐르거나 배경 문양이 강한 명함은 항목 분류가 어긋날 수 있습니다. 저장 전
  확인 화면에서 수정하세요.
- 항목 분류 규칙은 한국어/영문 명함을 기준으로 만들어졌습니다.
- 명함 영역 감지는 글자 위치를 근거로 하므로, 글자가 한쪽에 몰린 명함은 반대쪽 여백이
  덜 남을 수 있습니다. 미리보기를 보고 어긋나면 스위치를 꺼서 원본으로 저장하세요.
- 잘라내기는 파일을 덮어쓰므로 원본 사진은 남지 않습니다.
