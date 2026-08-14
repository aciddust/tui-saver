/**
 * Solid rotating cube: six flat-shaded faces plus highlighted edges.
 *
 * Faces are culled against the actual view vector rather than screen winding,
 * because we need the rotated normal for shading anyway and it saves reasoning
 * about which way the projection flips y.
 */

import type { Canvas } from '../core/canvas.ts';
import type { Scene, SceneEnv } from '../core/scene.ts';
import { camera, fillTri, lambert, lineZ, project, rot3sc, sincos } from '../core/raster.ts';

const A = 0.92;
// Body diagonal is A*sqrt(3) = 1.59, which sets the lens.
const cam = camera(4.2, 2.15, 0.9);

const VERTS = new Float32Array(8 * 3);
for (let i = 0; i < 8; i++) {
  VERTS[i * 3] = i & 1 ? A : -A;
  VERTS[i * 3 + 1] = i & 2 ? A : -A;
  VERTS[i * 3 + 2] = i & 4 ? A : -A;
}

type Face = { quad: readonly number[]; n: readonly number[] };
const FACES: readonly Face[] = [
  { quad: [1, 5, 7, 3], n: [1, 0, 0] },
  { quad: [0, 2, 6, 4], n: [-1, 0, 0] },
  { quad: [2, 3, 7, 6], n: [0, 1, 0] },
  { quad: [0, 1, 5, 4], n: [0, -1, 0] },
  { quad: [4, 5, 7, 6], n: [0, 0, 1] },
  { quad: [0, 1, 3, 2], n: [0, 0, -1] },
];

const sc = new Float32Array(6);
const rp = new Float32Array(8 * 3); // rotated verts
const sp = new Float32Array(8 * 3); // projected verts (px, py, depth)
const vis = new Uint8Array(8);
/** Which vertex pairs bound a face we actually drew this frame. */
const edgeMark = new Uint8Array(64);
const tmp = new Float32Array(3);
const out = new Float32Array(3);
const rgb = new Float32Array(3);

export const cube: Scene = {
  id: 'cube',
  title: 'cube',
  blurb: 'solid shaded cube with lit edges',
  mode: 'ascii',
  ramp: ' .:-=+*#%@',

  render(c: Canvas, env: SceneEnv): void {
    c.clear();
    edgeMark.fill(0);
    const t = env.t;
    sincos(sc, t * 0.47, t * 0.63, Math.sin(t * 0.21) * 0.5);

    for (let i = 0; i < 8; i++) {
      rot3sc(tmp, VERTS[i * 3], VERTS[i * 3 + 1], VERTS[i * 3 + 2], sc);
      rp[i * 3] = tmp[0];
      rp[i * 3 + 1] = tmp[1];
      rp[i * 3 + 2] = tmp[2];
      vis[i] = project(c, cam, tmp[0], tmp[1], tmp[2], out) ? 1 : 0;
      sp[i * 3] = out[0];
      sp[i * 3 + 1] = out[1];
      sp[i * 3 + 2] = out[2];
    }

    for (let f = 0; f < FACES.length; f++) {
      const face = FACES[f];
      rot3sc(tmp, face.n[0], face.n[1], face.n[2], sc);
      const nx = tmp[0];
      const ny = tmp[1];
      const nz = tmp[2];
      const q = face.quad;
      if (!vis[q[0]] || !vis[q[1]] || !vis[q[2]] || !vis[q[3]]) continue;
      // Face centre in eye space; the eye sits at the origin once cam.dist is
      // folded into z.
      let ex = 0;
      let ey = 0;
      let ez = 0;
      for (const idx of q) {
        ex += rp[idx * 3];
        ey += rp[idx * 3 + 1];
        ez += rp[idx * 3 + 2] + cam.dist;
      }
      ex /= 4;
      ey /= 4;
      ez /= 4;
      if (nx * ex + ny * ey + nz * ez > 0) continue; // facing away
      for (let k = 0; k < 4; k++) {
        const u = q[k];
        const v = q[(k + 1) & 3];
        edgeMark[u * 8 + v] = 1;
      }

      const shade = 0.14 + 0.86 * lambert(nx, ny, nz);
      env.palette.sample(0.12 + (f / FACES.length) * 0.35 + shade * 0.5, rgb, 0);
      for (const [a, b] of [
        [1, 2],
        [2, 3],
      ]) {
        fillTri(
          c,
          sp[q[0] * 3], sp[q[0] * 3 + 1], sp[q[0] * 3 + 2],
          sp[q[a] * 3], sp[q[a] * 3 + 1], sp[q[a] * 3 + 2],
          sp[q[b] * 3], sp[q[b] * 3 + 1], sp[q[b] * 3 + 2],
          shade, rgb[0], rgb[1], rgb[2],
          false,
        );
      }
    }

    // Edges last, biased towards the camera so they win the depth test against
    // the faces they border. Only edges of faces we actually drew are stroked:
    // depth-testing the hidden ones is not reliable, because fillTri and lineZ
    // both interpolate depth affinely in screen space and the two disagree by
    // enough to let a back edge bleed through a large face.
    env.palette.sample(0.97, rgb, 0);
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        if (!edgeMark[u * 8 + v]) continue;
        if (!vis[u] || !vis[v]) continue;
        lineZ(
          c,
          sp[u * 3], sp[u * 3 + 1], sp[u * 3 + 2] - 0.05,
          sp[v * 3], sp[v * 3 + 1], sp[v * 3 + 2] - 0.05,
          1, rgb[0], rgb[1], rgb[2],
        );
      }
    }
  },
};
