/**
 * webtorrent 3.0.16 violates its own invariant that `pieces[i] === null`
 * implies `bitfield.get(i) === true`. _markVerified() (lib/torrent.js) releases
 * a piece by setting it to null, but several call sites read a piece whenever
 * the bitfield bit is unset and assume it must therefore be non-null. When the
 * two fall out of sync the process dies with:
 *
 *   TypeError: Cannot read properties of null (reading 'length')
 *   TypeError: Cannot read properties of null (reading 'missing')
 *
 * These crashes fire from webtorrent's own timers — the `downloaded` getter is
 * read by getAnnounceOpts() on every tracker announce, and the piece picker
 * runs from _update() — so they cannot be contained at the call site. Each
 * patch below treats a null piece as verified, matching _markVerified().
 *
 * Re-run after every `npm install`.
 */
import { readFile, writeFile } from "node:fs/promises";

const TARGET = new URL(
  "../node_modules/webtorrent/lib/torrent.js",
  import.meta.url,
);

const PATCHES = [
  {
    name: "downloaded getter",
    broken: `      } else { // "in progress" data
        const piece = this.pieces[index]
        downloaded += (piece.length - piece.missing)
      }`,
    fixed: `      } else { // "in progress" data
        const piece = this.pieces[index]
        // A null piece means _markVerified() already released it; the bitfield
        // bit can lag behind, so treat it as a fully downloaded piece.
        downloaded += piece
          ? (piece.length - piece.missing)
          : ((index === len - 1) ? this.lastPieceLength : this.pieceLength)
      }`,
  },
  {
    name: "speedRanker piece picker",
    broken: `        if (!tries || self.bitfield.get(index)) return true

        let missing = self.pieces[index].missing`,
    fixed: `        if (!tries || self.bitfield.get(index)) return true

        // A null piece is already verified, same as a set bitfield bit.
        const rankedPiece = self.pieces[index]
        if (!rankedPiece) return true

        let missing = rankedPiece.missing`,
  },
  {
    name: "_request piece reservation",
    broken: `    const piece = self.pieces[index]
    let reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()`,
    fixed: `    const piece = self.pieces[index]
    // A null piece is already verified, same as the bitfield check above.
    if (!piece) return false
    let reservation = isWebSeed ? piece.reserveRemaining() : piece.reserve()`,
  },
  {
    name: "hotswap request cancel",
    broken: `      this.pieces[index].cancel((req.offset / Piece.BLOCK_LENGTH) | 0)`,
    fixed: `      // Nothing to cancel if the piece was verified and released.
      this.pieces[index]?.cancel((req.offset / Piece.BLOCK_LENGTH) | 0)`,
  },
];

let source = await readFile(TARGET, "utf8");
let applied = 0;
let failed = 0;

for (const { name, broken, fixed } of PATCHES) {
  if (source.includes(fixed)) {
    console.log(`webtorrent: ${name} — already patched.`);
  } else if (source.includes(broken)) {
    source = source.replace(broken, fixed);
    applied += 1;
    console.log(`webtorrent: ${name} — patched.`);
  } else {
    failed += 1;
    console.error(
      `webtorrent: ${name} — expected code not found. The dependency likely ` +
        `changed version; re-check lib/torrent.js before relying on this.`,
    );
  }
}

if (applied > 0) await writeFile(TARGET, source, "utf8");
if (failed > 0) process.exitCode = 1;
