"""Command line entry point: ``python3 -m docviewer [PATH]``."""

import argparse
import os
import socket
import sys
import threading
import webbrowser

from docviewer import __version__, phonepage, samples
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
    parser.add_argument("--lan", action="store_true",
                        help="같은 와이파이의 휴대폰에서도 접속할 수 있게 엽니다")
    parser.add_argument("--build-phone-page", metavar="FILE",
                        help="휴대폰용 단일 HTML 파일을 만들고 끝냅니다")
    parser.add_argument("--version", action="version", version="docviewer %s" % __version__)
    return parser


def lan_address():
    """Return the address of this machine on the local network, if there is one."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # no packet is sent - this only asks the routing table which address would be used
        probe.connect(("192.0.2.1", 9))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def main(argv=None):
    options = build_parser().parse_args(argv)
    if options.build_phone_page:
        destination = os.path.expanduser(options.build_phone_page)
        phonepage.build(destination)
        print("휴대폰용 파일을 만들었습니다: %s (%d KB)"
              % (destination, os.path.getsize(destination) // 1024))
        print("이 파일 하나만 휴대폰으로 옮기면 인터넷 없이도 열립니다.")
        return 0
    target = os.path.expanduser(options.path)
    if options.samples:
        target = os.path.expanduser(options.samples)
        created = samples.build_all(target)
        print("예제 파일 %d개를 만들었습니다: %s" % (len(created), target))
    if not os.path.exists(target):
        print("경로를 찾을 수 없습니다: %s" % target, file=sys.stderr)
        return 2
    host = "0.0.0.0" if options.lan else options.host
    port = options.port
    if port != 0:
        port = find_free_port(host, options.port)
        if port != options.port:
            print("포트 %d 이(가) 사용 중이라 %d 번을 사용합니다." % (options.port, port))
    try:
        server = create_server(target, host=host, port=port,
                               show_hidden=options.show_hidden,
                               allow_any_host=options.allow_any_host or options.lan,
                               quiet=options.quiet)
    except OSError as exc:
        print("서버를 시작할 수 없습니다: %s" % exc, file=sys.stderr)
        return 1
    url = server.url
    if server.initial_file:
        url += "?file=" + server.initial_file
    print("문서 뷰어가 시작되었습니다: %s" % url)
    print("보여줄 폴더: %s" % server.root)
    if options.lan:
        address = lan_address()
        if address:
            print("휴대폰에서는 같은 와이파이에 연결한 뒤 이 주소로 여세요: "
                  "http://%s:%d/" % (address, server.server_address[1]))
            print("휴대폰 브라우저 메뉴에서 '홈 화면에 추가'를 누르면 앱처럼 설치됩니다.")
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
