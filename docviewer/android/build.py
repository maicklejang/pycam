#!/usr/bin/env python3
"""Build the android apk without gradle.

The app is one activity and one asset file, so the plain sdk tools are enough:

    javac   -> class files (java 8 bytecode, no lambdas: dx cannot desugar them)
    dx/d8   -> classes.dex
    aapt    -> apk with the manifest, resources and assets
    zipalign + apksigner -> an installable, signed apk

Tools are looked up in ANDROID_HOME, in the debian android-sdk packages and on
PATH, so this works both with google's sdk and with the distribution packages.

    python3 docviewer/android/build.py [--output docviewer.apk] [--release KEYSTORE]
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile


HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.dirname(PACKAGE_ROOT))

from docviewer import icons, phonepage  # noqa: E402  (needs the path above)


class BuildError(Exception):
    """Raised when a tool is missing or refuses to do its job."""


def main(argv=None):
    parser = argparse.ArgumentParser(description="docviewer 안드로이드 앱을 빌드합니다.")
    parser.add_argument("--output", default=os.path.join(HERE, "docviewer.apk"),
                        help="만들어질 apk 경로")
    parser.add_argument("--keystore", help="서명에 쓸 키스토어 (기본: 디버그 키스토어)")
    parser.add_argument("--keystore-pass", default="android", help="키스토어 비밀번호")
    parser.add_argument("--key-alias", default="androiddebugkey", help="키 별칭")
    parser.add_argument("--android-jar", help="android.jar 경로")
    parser.add_argument("--dx", help="dx 또는 d8 실행 파일 / dx jar 경로")
    options = parser.parse_args(argv)
    try:
        path = build(options)
    except BuildError as error:
        print("빌드 실패: %s" % error, file=sys.stderr)
        return 1
    size = os.path.getsize(path)
    readable = ("%.1f MB" % (size / 1024.0 / 1024)) if size >= 1024 * 1024 \
        else ("%d KB" % (size // 1024))
    print("만들었습니다: %s (%s)" % (path, readable))
    print("휴대폰으로 옮겨 실행하면 설치됩니다. (설정에서 '출처를 알 수 없는 앱' 허용 필요)")
    return 0


def build(options):
    android_jar = options.android_jar or find_android_jar()
    aapt = find_tool("aapt")
    zipalign = find_tool("zipalign")
    apksigner = find_tool("apksigner")
    dexer = Dexer(options.dx)
    workdir = tempfile.mkdtemp(prefix="docviewer-apk-")
    try:
        assets = os.path.join(workdir, "assets")
        os.makedirs(assets)
        phonepage.build(os.path.join(assets, "index.html"))
        icons.write_all(PACKAGE_ROOT)

        classes = os.path.join(workdir, "classes")
        os.makedirs(classes)
        sources = glob.glob(os.path.join(HERE, "src", "**", "*.java"), recursive=True)
        run(["javac", "--release", "8", "-nowarn", "-encoding", "UTF-8",
             "-classpath", android_jar, "-d", classes] + sources,
            "자바 컴파일")

        dex_dir = os.path.join(workdir, "dex")
        os.makedirs(dex_dir)
        dexer.run(classes, dex_dir)

        unsigned = os.path.join(workdir, "unsigned.apk")
        run([aapt, "package", "-f", "-M", os.path.join(HERE, "AndroidManifest.xml"),
             "-S", os.path.join(HERE, "res"), "-A", assets, "-I", android_jar, "-F", unsigned],
            "리소스 패키징")
        run([aapt, "add", "-f", os.path.abspath(unsigned), "classes.dex"], "dex 추가",
            cwd=dex_dir)

        aligned = os.path.join(workdir, "aligned.apk")
        run([zipalign, "-f", "4", unsigned, aligned], "정렬")

        keystore = options.keystore or debug_keystore(workdir)
        run([apksigner, "sign", "--ks", keystore, "--ks-pass", "pass:" + options.keystore_pass,
             "--key-pass", "pass:" + options.keystore_pass, "--ks-key-alias", options.key_alias,
             "--out", options.output, aligned], "서명")
        run([apksigner, "verify", options.output], "서명 확인")
        return options.output
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Dexer:
    """Runs whichever dex compiler is available: d8, dx, or the dx jar."""

    def __init__(self, override=None):
        self.command = None
        self.jar = None
        candidate = override or os.environ.get("DOCVIEWER_DX")
        if candidate and candidate.endswith(".jar"):
            self.jar = candidate
        elif candidate:
            self.command = candidate
        else:
            for name in ("d8", "dx"):
                found = shutil.which(name) or sdk_tool(name)
                if found:
                    self.command = found
                    break
            else:
                self.jar = find_dx_jar()
        if not self.command and not self.jar:
            raise BuildError("dex 변환기(d8 또는 dx)를 찾지 못했습니다. --dx 로 지정해 주세요.")

    def run(self, classes_directory, output_directory):
        class_files = glob.glob(os.path.join(classes_directory, "**", "*.class"), recursive=True)
        if not class_files:
            raise BuildError("컴파일된 클래스 파일이 없습니다.")
        dex = os.path.join(output_directory, "classes.dex")
        if self.command and os.path.basename(self.command).startswith("d8"):
            run([self.command, "--output", output_directory, "--min-api", "21"] + class_files,
                "dex 변환")
            return
        # dx derives the class name from the path it is given, so it has to be
        # called from the directory the packages start in
        if self.jar:
            command = ["java", "-cp", self.jar, "com.android.dx.command.Main"]
        else:
            command = [self.command]
        run(command + ["--dex", "--output=" + dex, "."], "dex 변환", cwd=classes_directory)


def debug_keystore(workdir):
    """Return the usual debug keystore, creating it when it is missing."""
    path = os.path.join(os.path.expanduser("~"), ".android", "debug.keystore")
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    run(["keytool", "-genkeypair", "-keystore", path, "-storepass", "android",
         "-keypass", "android", "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
         "-validity", "10000", "-dname", "CN=Android Debug,O=Android,C=US"],
        "디버그 키 생성")
    return path


def find_android_jar():
    for pattern in (os.path.join(os.environ.get("ANDROID_HOME", "/nonexistent"),
                                 "platforms", "*", "android.jar"),
                    "/usr/lib/android-sdk/platforms/*/android.jar"):
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    raise BuildError("android.jar 을 찾지 못했습니다. ANDROID_HOME 을 설정하거나 "
                     "'apt install android-sdk-platform-23' 후 다시 시도해 주세요.")


def sdk_tool(name):
    roots = [os.environ.get("ANDROID_HOME"), "/usr/lib/android-sdk"]
    for root in roots:
        if not root:
            continue
        found = sorted(glob.glob(os.path.join(root, "build-tools", "*", name)))
        if found:
            return found[-1]
    return None


def find_tool(name):
    found = shutil.which(name) or sdk_tool(name)
    if not found:
        raise BuildError("%s 을(를) 찾지 못했습니다. 안드로이드 빌드 도구를 설치해 주세요." % name)
    return found


def find_dx_jar():
    for pattern in ("/opt/dextools/*.jar", "/usr/share/java/dx.jar",
                    os.path.join(os.path.expanduser("~"), ".docviewer", "dx*.jar")):
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    return None


def run(command, what, cwd=None):
    result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        output = result.stdout.decode("utf-8", "replace").strip()
        raise BuildError("%s 단계에서 실패했습니다.\n%s" % (what, output))
    return result.stdout.decode("utf-8", "replace")


if __name__ == "__main__":
    sys.exit(main())
