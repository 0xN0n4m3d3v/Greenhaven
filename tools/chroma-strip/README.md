# chroma-strip

Tiny Rust CLI that removes pure-magenta `#FF00FF` backgrounds from
PNGs and writes a transparent-alpha cutout. Built to prep AI-generated
art (which we render against magenta on purpose, exactly the way
sticker-studio does) for the Greenhaven loading screen and any other
in-game art that needs a clean alpha channel.

The chroma-key algorithm is ported verbatim from
`kit/ena-chat/tools/sticker-studio/src/pipeline.rs` — HSV hue-band
match around 300°, corner-connected flood fill so any accidental
magenta *inside* the silhouette survives, soft despill at the edge.

## Build

```bash
cd tools/chroma-strip
cargo build --release
# binary: target/release/chroma-strip(.exe)
```

## Usage

Single file:

```bash
chroma-strip input.png                 # writes input.cutout.png next to it
chroma-strip input.png out.png         # explicit output
chroma-strip input.png --resize 1024   # also resize longest edge to 1024
```

Batch a directory:

```bash
chroma-strip ./art --batch                       # → ./art/cutout/*.png
chroma-strip ./art --batch --out-dir ./cutouts   # custom output dir
chroma-strip ./art --batch --resize 1920         # resize each
```

## Notes

- Input must contain a roughly-pure magenta background. Anti-aliased
  edges are handled by the soft band; full saturated magenta inside
  the subject would be misclassified — keep the convention from
  sticker-studio (no magenta on the character itself).
- Output is always PNG with an alpha channel, regardless of input
  format the `image` crate can decode.
- `--resize N` fits the image inside an `N × N` box preserving aspect
  ratio (Lanczos3). Omit to keep native resolution.
