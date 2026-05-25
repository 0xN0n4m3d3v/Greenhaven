// Spec 37 §A.1 — ambient declarations for png-chunks-{encode,extract}
// (no upstream types). Each chunk is {name, data: Uint8Array}.

declare module 'png-chunks-encode' {
  interface PngChunk {
    name: string;
    data: Uint8Array;
  }
  const encode: (chunks: PngChunk[]) => Uint8Array;
  export default encode;
}

declare module 'png-chunks-extract' {
  interface PngChunk {
    name: string;
    data: Uint8Array;
  }
  const extract: (buf: Uint8Array) => PngChunk[];
  export default extract;
}
