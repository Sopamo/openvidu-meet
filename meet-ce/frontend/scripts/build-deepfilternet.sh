#!/bin/sh
# comeet: builds the DeepFilterNet3 noise suppression runtime into src/assets/deepfilternet/ (committed, like the
# selfie-segmenter model): the WebAssembly build of upstream libDF, its wasm-bindgen JS glue and the DFN3 model.
# The AudioWorklet that uses them (deepfilter-worklet.js, text-codec-polyfill.js) lives next to them and is
# hand-written.
#
# Runs in Docker so no Rust toolchain is needed locally. Rerun only to update DeepFilterNet:
#   meet-ce/frontend/scripts/build-deepfilternet.sh
set -eu

DEEPFILTERNET_COMMIT=7b14b895fe7fc42cab72b4a4c1e49c982bd6404b # Rikorose/DeepFilterNet main, 2026-11-06
WASM_BINDGEN=0.2.126
BINARYEN=version_123

OUT="$(cd "$(dirname "$0")/.." && pwd)/src/assets/deepfilternet"
mkdir -p "$OUT"

docker run --rm -i -v "$OUT:/out" \
	-e DEEPFILTERNET_COMMIT="$DEEPFILTERNET_COMMIT" -e WASM_BINDGEN="$WASM_BINDGEN" -e BINARYEN="$BINARYEN" \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	docker.io/rust:1-bookworm sh -eux <<'EOF'
rustup target add wasm32-unknown-unknown
curl -sSfL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$WASM_BINDGEN/wasm-bindgen-$WASM_BINDGEN-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C /tmp
curl -sSfL "https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN/binaryen-$BINARYEN-x86_64-linux.tar.gz" | tar -xz -C /tmp
export PATH="/tmp/wasm-bindgen-$WASM_BINDGEN-x86_64-unknown-linux-musl:/tmp/binaryen-$BINARYEN/bin:$PATH"

git init -q /src && cd /src
git fetch -q --depth 1 https://github.com/Rikorose/DeepFilterNet "$DEEPFILTERNET_COMMIT" && git checkout -q FETCH_HEAD
cd libDF
# The model is loaded at runtime (df_create(model_bytes, ...)), so don't embed a second copy in the WASM;
# pin wasm-bindgen to the CLI version above (the glue and the binary must match).
sed -i 's/^  "default-model",$//' Cargo.toml
sed -i "s/^wasm-bindgen = { version = \"[^\"]*\"/wasm-bindgen = { version = \"=$WASM_BINDGEN\"/" Cargo.toml
# The WASM API only exposes the attenuation limit and the post filter; add a setter for the local-SNR thresholds
# (the LADSPA plugin exposes them as controls too), see the comment on SNR_THRESHOLDS in audio-track-processor.service.ts.
cat >> src/wasm.rs <<'RS'

/// comeet: Set the local SNR thresholds (dB) that switch the processing stages: below `min_db` the frame is
/// treated as noise only (silent spectrum), above `max_erb_db` it is left as is, above `max_df_db` the deep
/// filter stage is skipped. Upstream defaults: -10, 30, 20.
#[wasm_bindgen]
pub unsafe fn df_set_thresholds(st: *mut DFState, min_db: f32, max_erb_db: f32, max_df_db: f32) {
    let state = st.as_mut().expect("Invalid pointer");
    state.0.min_db_thresh = min_db;
    state.0.max_db_erb_thresh = max_erb_db;
    state.0.max_db_df_thresh = max_df_db;
}
RS

RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals" \
	cargo rustc --lib --release --target wasm32-unknown-unknown --no-default-features --features wasm --crate-type cdylib
wasm-bindgen --target web --out-dir /tmp/pkg --out-name df /src/target/wasm32-unknown-unknown/release/df.wasm
wasm-opt -O4 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-mutable-globals \
	/tmp/pkg/df_bg.wasm -o /out/df_bg.wasm
cp /tmp/pkg/df.js /out/df.js
cp /src/models/DeepFilterNet3_onnx.tar.gz /out/DeepFilterNet3_onnx.tar.gz
cp /src/LICENSE-MIT /out/LICENSE-MIT
cp /src/LICENSE-APACHE /out/LICENSE-APACHE
echo "Rikorose/DeepFilterNet $DEEPFILTERNET_COMMIT, wasm-bindgen $WASM_BINDGEN" > /out/VERSION
chown "$HOST_UID:$HOST_GID" /out/*
EOF

ls -la "$OUT"
