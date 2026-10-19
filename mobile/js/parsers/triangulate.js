/* PyCAM Viewer - 2D polygon triangulation (ear clipping with hole bridging).
 *
 * Used to tessellate trimmed STEP faces in their surface parameter space.
 *
 * Copyright 2026 The PyCAM contributors
 * Licensed under the GNU General Public License v3 or later (see COPYING.TXT).
 */
(function (root) {
    "use strict";

    var P = root.PVX = root.PVX || {};

    function Node(index, x, y) {
        this.i = index;
        this.x = x;
        this.y = y;
        this.prev = null;
        this.next = null;
        this.steiner = false;
    }

    function insertNode(index, x, y, last) {
        var node = new Node(index, x, y);
        if (!last) {
            node.prev = node;
            node.next = node;
        } else {
            node.next = last.next;
            node.prev = last;
            last.next.prev = node;
            last.next = node;
        }
        return node;
    }

    function removeNode(node) {
        node.next.prev = node.prev;
        node.prev.next = node.next;
    }

    function signedArea(data, start, end) {
        var sum = 0;
        for (var i = start, j = end - 2; i < end; i += 2) {
            sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
            j = i;
        }
        return sum;
    }

    function linkedList(data, start, end, counterClockwise) {
        var last = null;
        var i;
        if ((signedArea(data, start, end) > 0) === counterClockwise) {
            for (i = start; i < end; i += 2) {
                last = insertNode(i, data[i], data[i + 1], last);
            }
        } else {
            for (i = end - 2; i >= start; i -= 2) {
                last = insertNode(i, data[i], data[i + 1], last);
            }
        }
        if (last && equals(last, last.next)) {
            removeNode(last);
            last = last.next;
        }
        return last;
    }

    function filterPoints(start, end) {
        if (!start) {
            return start;
        }
        end = end || start;
        var node = start;
        var again;
        do {
            again = false;
            if (!node.steiner && (equals(node, node.next) || area(node.prev, node, node.next) === 0)) {
                removeNode(node);
                node = end = node.prev;
                if (node === node.next) {
                    break;
                }
                again = true;
            } else {
                node = node.next;
            }
        } while (again || node !== end);
        return end;
    }

    function area(p, q, r) {
        return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
    }

    function equals(p1, p2) {
        return p1.x === p2.x && p1.y === p2.y;
    }

    function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
        return (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0
            && (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0
            && (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0;
    }

    function isEar(ear) {
        var a = ear.prev, b = ear, c = ear.next;
        if (area(a, b, c) >= 0) {
            return false;   // reflex
        }
        var node = ear.next.next;
        while (node !== ear.prev) {
            if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, node.x, node.y)
                    && area(node.prev, node, node.next) >= 0) {
                return false;
            }
            node = node.next;
        }
        return true;
    }

    function intersects(p1, q1, p2, q2) {
        var o1 = Math.sign(area(p1, q1, p2));
        var o2 = Math.sign(area(p1, q1, q2));
        var o3 = Math.sign(area(p2, q2, p1));
        var o4 = Math.sign(area(p2, q2, q1));
        if (o1 !== o2 && o3 !== o4) {
            return true;
        }
        return false;
    }

    function intersectsPolygon(a, b) {
        var node = a;
        do {
            if (node.i !== a.i && node.next.i !== a.i && node.i !== b.i && node.next.i !== b.i
                    && intersects(node, node.next, a, b)) {
                return true;
            }
            node = node.next;
        } while (node !== a);
        return false;
    }

    function locallyInside(a, b) {
        return area(a.prev, a, a.next) < 0
            ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
            : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
    }

    function middleInside(a, b) {
        var node = a;
        var inside = false;
        var px = (a.x + b.x) / 2;
        var py = (a.y + b.y) / 2;
        do {
            if (((node.y > py) !== (node.next.y > py)) && node.next.y !== node.y
                    && (px < (node.next.x - node.x) * (py - node.y) / (node.next.y - node.y) + node.x)) {
                inside = !inside;
            }
            node = node.next;
        } while (node !== a);
        return inside;
    }

    function splitPolygon(a, b) {
        var a2 = new Node(a.i, a.x, a.y);
        var b2 = new Node(b.i, b.x, b.y);
        var an = a.next;
        var bp = b.prev;
        a.next = b;
        b.prev = a;
        a2.next = an;
        an.prev = a2;
        b2.next = a2;
        a2.prev = b2;
        bp.next = b2;
        b2.prev = bp;
        return b2;
    }

    function findHoleBridge(hole, outer) {
        var node = outer;
        var qx = -Infinity;
        var m = null;
        // Cast a ray to the left from the hole's leftmost point.
        do {
            if (hole.y <= node.y && hole.y >= node.next.y && node.next.y !== node.y) {
                var x = node.x + (hole.y - node.y) * (node.next.x - node.x) / (node.next.y - node.y);
                if (x <= hole.x && x > qx) {
                    qx = x;
                    m = node.x < node.next.x ? node : node.next;
                    if (x === hole.x) {
                        return m;
                    }
                }
            }
            node = node.next;
        } while (node !== outer);

        if (!m) {
            return null;
        }
        // Look for a better (visible) vertex inside the triangle hole-ray-m.
        var stop = m;
        var mx = m.x;
        var my = m.y;
        var tanMin = Infinity;
        node = m;
        do {
            if (hole.x >= node.x && node.x >= mx && hole.x !== node.x
                    && pointInTriangle(hole.y < my ? hole.x : qx, hole.y,
                                       mx, my,
                                       hole.y < my ? qx : hole.x, hole.y,
                                       node.x, node.y)) {
                var tan = Math.abs(hole.y - node.y) / (hole.x - node.x);
                if (locallyInside(node, hole)
                        && (tan < tanMin || (tan === tanMin
                            && (node.x > m.x || (node.x === m.x && node.y > m.y))))) {
                    m = node;
                    tanMin = tan;
                }
            }
            node = node.next;
        } while (node !== stop);
        return m;
    }

    function getLeftmost(start) {
        var node = start;
        var leftmost = start;
        do {
            if (node.x < leftmost.x || (node.x === leftmost.x && node.y < leftmost.y)) {
                leftmost = node;
            }
            node = node.next;
        } while (node !== start);
        return leftmost;
    }

    function eliminateHole(hole, outer) {
        var bridge = findHoleBridge(hole, outer);
        if (!bridge) {
            return outer;
        }
        var reverse = splitPolygon(bridge, hole);
        filterPoints(reverse, reverse.next);
        return filterPoints(bridge, bridge.next);
    }

    function eliminateHoles(data, holeIndices, outerNode) {
        var queue = [];
        var i, start, end, list;
        for (i = 0; i < holeIndices.length; i++) {
            start = holeIndices[i] * 2;
            end = i < holeIndices.length - 1 ? holeIndices[i + 1] * 2 : data.length;
            list = linkedList(data, start, end, false);
            if (list) {
                if (list === list.next) {
                    list.steiner = true;
                }
                queue.push(getLeftmost(list));
            }
        }
        queue.sort(function (a, b) {
            return a.x - b.x;
        });
        for (i = 0; i < queue.length; i++) {
            outerNode = eliminateHole(queue[i], outerNode);
        }
        return outerNode;
    }

    function cureLocalIntersections(start, triangles) {
        var node = start;
        do {
            var a = node.prev;
            var b = node.next.next;
            if (!equals(a, b) && intersects(a, node, node.next, b)
                    && locallyInside(a, b) && locallyInside(b, a)) {
                triangles.push(a.i / 2, node.i / 2, b.i / 2);
                removeNode(node);
                removeNode(node.next);
                node = start = b;
            }
            node = node.next;
        } while (node !== start);
        return filterPoints(node);
    }

    function splitEarcut(start, triangles, depth) {
        var a = start;
        do {
            var b = a.next.next;
            while (b !== a.prev) {
                if (a.i !== b.i && isValidDiagonal(a, b)) {
                    var c = splitPolygon(a, b);
                    a = filterPoints(a, a.next);
                    c = filterPoints(c, c.next);
                    earcutLinked(a, triangles, 0, depth + 1);
                    earcutLinked(c, triangles, 0, depth + 1);
                    return;
                }
                b = b.next;
            }
            a = a.next;
        } while (a !== start);
    }

    function isValidDiagonal(a, b) {
        return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b)
            && locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b);
    }

    function earcutLinked(ear, triangles, pass, depth) {
        if (!ear) {
            return;
        }
        depth = depth || 0;
        if (depth > 64) {
            return;
        }
        var stop = ear;
        while (ear.prev !== ear.next) {
            var prev = ear.prev;
            var next = ear.next;
            if (isEar(ear)) {
                triangles.push(prev.i / 2, ear.i / 2, next.i / 2);
                removeNode(ear);
                ear = next.next;
                stop = next.next;
                continue;
            }
            ear = next;
            if (ear === stop) {
                if (!pass) {
                    earcutLinked(filterPoints(ear), triangles, 1, depth);
                } else if (pass === 1) {
                    ear = cureLocalIntersections(filterPoints(ear), triangles);
                    earcutLinked(ear, triangles, 2, depth);
                } else if (pass === 2) {
                    splitEarcut(ear, triangles, depth);
                }
                break;
            }
        }
    }

    /* Lawson edge flips towards a Delaunay triangulation.
     *
     * Ear clipping is happy to emit very long, thin triangles.  On a flat face
     * nobody cares, but on a curved surface those long chords cut through the
     * solid and inflate the mesh once it gets refined, so the interior edges are
     * flipped until the triangles are well shaped.  Boundary edges (the trimming
     * loops) appear in a single triangle and are never touched.
     */
    function orient(data, a, b, c) {
        return (data[b * 2] - data[a * 2]) * (data[c * 2 + 1] - data[a * 2 + 1])
            - (data[c * 2] - data[a * 2]) * (data[b * 2 + 1] - data[a * 2 + 1]);
    }

    function inCircle(data, a, b, c, d) {
        var adx = data[a * 2] - data[d * 2], ady = data[a * 2 + 1] - data[d * 2 + 1];
        var bdx = data[b * 2] - data[d * 2], bdy = data[b * 2 + 1] - data[d * 2 + 1];
        var cdx = data[c * 2] - data[d * 2], cdy = data[c * 2 + 1] - data[d * 2 + 1];
        return (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy)
            - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady)
            + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
    }

    P.improveTriangulation = function (data, indices) {
        var count = indices.length / 3;
        if (count < 2) {
            return indices;
        }
        // Normalise every triangle to counter-clockwise so the tests below hold.
        var i;
        for (i = 0; i < indices.length; i += 3) {
            if (orient(data, indices[i], indices[i + 1], indices[i + 2]) < 0) {
                var swap = indices[i + 1];
                indices[i + 1] = indices[i + 2];
                indices[i + 2] = swap;
            }
        }
        var maxFlips = Math.min(20000, count * 12);
        var flips = 0;
        var changed = true;
        while (changed && flips < maxFlips) {
            changed = false;
            var edges = new Map();
            for (i = 0; i < indices.length; i += 3) {
                for (var e = 0; e < 3; e++) {
                    var v0 = indices[i + e];
                    var v1 = indices[i + (e + 1) % 3];
                    var key = Math.min(v0, v1) + ":" + Math.max(v0, v1);
                    var entry = edges.get(key);
                    if (!entry) {
                        edges.set(key, [{tri: i, opposite: indices[i + (e + 2) % 3],
                                         a: v0, b: v1}]);
                    } else {
                        entry.push({tri: i, opposite: indices[i + (e + 2) % 3], a: v0, b: v1});
                    }
                }
            }
            var touched = new Set();
            edges.forEach(function (entry) {
                if (entry.length !== 2 || flips >= maxFlips) {
                    return;
                }
                var first = entry[0];
                var second = entry[1];
                if (touched.has(first.tri) || touched.has(second.tri)) {
                    return;
                }
                var a = first.a, b = first.b;
                var c = first.opposite, d = second.opposite;
                if (c === d) {
                    return;
                }
                // Triangle (a,b,c) is counter-clockwise, so d sits on the other
                // side of a-b; the quad a-d-b-c must be strictly convex to flip.
                if (!(orient(data, a, d, c) > 0 && orient(data, d, b, c) > 0)) {
                    return;
                }
                if (inCircle(data, a, b, c, d) <= 0) {
                    return;   // already locally Delaunay
                }
                indices[first.tri] = a;
                indices[first.tri + 1] = d;
                indices[first.tri + 2] = c;
                indices[second.tri] = d;
                indices[second.tri + 1] = b;
                indices[second.tri + 2] = c;
                touched.add(first.tri);
                touched.add(second.tri);
                flips++;
                changed = true;
            });
        }
        return indices;
    };

    /* data: flat [x0, y0, x1, y1, ...]; holeIndices: vertex index where each hole starts.
     * Returns a flat array of triangle vertex indices. */
    P.triangulate = function (data, holeIndices) {
        var hasHoles = holeIndices && holeIndices.length;
        var outerLen = hasHoles ? holeIndices[0] * 2 : data.length;
        var outerNode = linkedList(data, 0, outerLen, true);
        var triangles = [];
        if (!outerNode || outerNode.next === outerNode.prev) {
            return triangles;
        }
        if (hasHoles) {
            outerNode = eliminateHoles(data, holeIndices, outerNode);
        }
        earcutLinked(outerNode, triangles, 0, 0);
        return triangles;
    };
})(typeof self !== "undefined" ? self : this);
