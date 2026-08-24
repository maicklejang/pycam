"""Command line entry point: ``python3 -m docviewer [PATH]``."""

import argparse
import os
import sys
import threading
import webbrowser

from docviewer import __version__, samples
from docviewer.server import create_server, find_free_port


def build_parser():
    parser = argparse.ArgumentParser(
        prog="docviewer",
        description="PDF, 워드, 엑셀, 파워포인트, 그림 파일을 브라우저에서 보여주는 뷰어입니다.")
    parser.add_argument("path", nargs="?", default=".",
                        help="열어볼 파일 또는 폴더 (기본값: 현재 폴더)")
    parser.add_argument("--host", default="127.0.0.1", help="바인딩할 주소 (기본값: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8800, help="포트 번호 (기본값: 8800)")
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 열지 않습니다")
    parser.add_argument("--show-hidden", action="store_true", help="숨김 파일도 목록에 표시합니다")
    parser.add_argument("--allow-any-host", action="store_true",
                        help="localhost 외의 호스트 이름으로도 접속을 허용합니다")
    parser.add_argument("--quiet", action="store_true", help="요청 로그를 출력하지 않습니다")
    parser.add_argument("--samples", metavar="DIR",
                        help="형식별 예제 파일을 DIR 에 만든 뒤 그 폴더를 엽니다")
    parser.add_argument("--version", action="version", version="docviewer %s" % __version__)
    return parser


def main(argv=None):
    options = build_parser().parse_args(argv)
    target = os.path.expanduser(options.path)
    if options.samples:
        target = os.path.expanduser(options.samples)
        created = samples.build_all(target)
        print("예제 파일 %d개를 만들었습니다: %s" % (len(created), target))
    if not os.path.exists(target):
        print("경로를 찾을 수 없습니다: %s" % target, file=sys.stderr)
        return 2
    port = options.port
    if port != 0:
        port = find_free_port(options.host, options.port)
        if port != options.port:
            print("포트 %d 이(가) 사용 중이라 %d 번을 사용합니다." % (options.port, port))
    try:
        server = create_server(target, host=options.host, port=port,
                               show_hidden=options.show_hidden,
                               allow_any_host=options.allow_any_host,
                               quiet=options.quiet)
    except OSError as exc:
        print("서버를 시작할 수 없습니다: %s" % exc, file=sys.stderr)
        return 1
    url = server.url
    if server.initial_file:
        url += "?file=" + server.initial_file
    print("문서 뷰어가 시작되었습니다: %s" % url)
    print("보여줄 폴더: %s" % server.root)
    print("끝내려면 Ctrl-C 를 누르세요.")
    if not options.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
