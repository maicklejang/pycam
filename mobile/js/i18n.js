/* PyCAM Viewer - tiny translation layer (Korean / English).
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    var STRINGS = {
        ko: {
            appName: "PyCAM Viewer",
            tagline: "STL · STEP · DXF",
            open: "파일 열기",
            details: "정보",
            fit: "화면에 맞춤",
            views: "시점",
            shading: "표시 방식",
            grid: "격자",
            snapshot: "이미지 저장",
            measure: "치수 측정",
            clearMeasure: "측정 지우기",
            measureStart: "모서리나 면을 탭해 첫 번째 점을 선택하세요",
            measureSecond: "두 번째 점을 선택하세요",
            measureMiss: "모델 위를 탭해 주세요",
            measureDistance: "거리",
            measurePoint: "점",
            snapVertex: "꼭짓점", snapEdge: "모서리", snapSurface: "면",
            viewIso: "아이소", viewTop: "위", viewFront: "앞", viewRight: "오른쪽",
            viewLeft: "왼쪽", viewBack: "뒤", viewBottom: "아래",
            welcomeTitle: "3D/2D 도면을 바로 열어보세요",
            welcomeText: "STL, STEP(STP), DXF 파일을 휴대폰에서 바로 확인합니다. 파일은 기기 밖으로 전송되지 않습니다.",
            openFile: "파일 선택",
            recent: "최근 파일",
            installHint: "홈 화면에 추가하면 오프라인에서도 앱처럼 사용할 수 있습니다.",
            tabInfo: "정보", tabLayers: "레이어", tabDisplay: "보기",
            shadedSolid: "솔리드", shadedEdges: "솔리드 + 모서리", wireframe: "와이어프레임",
            projection: "투영", perspective: "원근", orthographic: "직교",
            axes: "축", bbox: "경계 상자", lock: "회전 잠금 (2D)",
            statFormat: "형식", statSize: "파일 크기", statSizeXYZ: "크기 (X·Y·Z)",
            statTriangles: "삼각형", statTime: "해석 시간", statLayersCount: "레이어",
            loading: "불러오는 중", parsing: "해석 중", packing: "화면 준비 중",
            reading: "파일 읽는 중", geometry: "형상 생성 중", entities: "엔티티 읽는 중",
            errorPrefix: "열 수 없습니다: ",
            noLayers: "이 형식에는 레이어 정보가 없습니다.",
            savedImage: "이미지를 저장했습니다.",
            unsupported: "이 브라우저는 WebGL을 지원하지 않습니다."
        },
        en: {
            appName: "PyCAM Viewer",
            tagline: "STL · STEP · DXF",
            open: "Open file",
            details: "Details",
            fit: "Fit to view",
            views: "Views",
            shading: "Display mode",
            grid: "Grid",
            snapshot: "Save image",
            measure: "Measure",
            clearMeasure: "Clear measurement",
            measureStart: "Tap an edge or a face to set the first point",
            measureSecond: "Now pick the second point",
            measureMiss: "Tap on the model",
            measureDistance: "Distance",
            measurePoint: "Point",
            snapVertex: "corner", snapEdge: "edge", snapSurface: "face",
            viewIso: "Isometric", viewTop: "Top", viewFront: "Front", viewRight: "Right",
            viewLeft: "Left", viewBack: "Back", viewBottom: "Bottom",
            welcomeTitle: "Open CAD files right on your phone",
            welcomeText: "View STL, STEP (STP) and DXF files directly on your device. Nothing is uploaded anywhere.",
            openFile: "Choose a file",
            recent: "Recent files",
            installHint: "Add it to your home screen to use it offline, like a native app.",
            tabInfo: "Info", tabLayers: "Layers", tabDisplay: "View",
            shadedSolid: "Solid", shadedEdges: "Solid + edges", wireframe: "Wireframe",
            projection: "Projection", perspective: "Perspective", orthographic: "Orthographic",
            axes: "Axes", bbox: "Bounding box", lock: "Lock rotation (2D)",
            statFormat: "Format", statSize: "File size", statSizeXYZ: "Size (X·Y·Z)",
            statTriangles: "Triangles", statTime: "Parse time", statLayersCount: "Layers",
            loading: "Loading", parsing: "Parsing", packing: "Preparing view",
            reading: "Reading file", geometry: "Building geometry", entities: "Reading entities",
            errorPrefix: "Cannot open: ",
            noLayers: "This format carries no layer information.",
            savedImage: "Image saved.",
            unsupported: "This browser does not support WebGL."
        }
    };

    var language = (root.navigator && root.navigator.language || "en")
        .toLowerCase().indexOf("ko") === 0 ? "ko" : "en";

    P.t = function (key) {
        return STRINGS[language][key] || STRINGS.en[key] || key;
    };

    P.applyTranslations = function (scope) {
        (scope || root.document).querySelectorAll("[data-i18n]").forEach(function (node) {
            node.textContent = P.t(node.getAttribute("data-i18n"));
        });
        (scope || root.document).querySelectorAll("[data-i18n-title]").forEach(function (node) {
            var text = P.t(node.getAttribute("data-i18n-title"));
            node.setAttribute("title", text);
            node.setAttribute("aria-label", text);
        });
    };
})(typeof self !== "undefined" ? self : this);
