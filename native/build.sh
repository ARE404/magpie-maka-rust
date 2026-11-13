#!/bin/sh
set -eu
root=$(cd "${1:?Pass a Rust Maka source checkout}" && pwd)
here=$(cd "$(dirname "$0")/.." && pwd)
examples="$root/products/maka/client/examples"
mkdir -p "$examples"
name=magpie_maka_helper_$$
file="$examples/$name.rs"
(set -C; cat "$here/native/helper.rs" > "$file")
trap 'rm "$file"; rmdir "$examples" 2>/dev/null || true' EXIT
cd "$root"
cargo build --locked -p maka-app-client --example "$name"
mkdir -p "$here/bin"
install -m 755 "target/debug/examples/$name" "$here/bin/magpie-maka-helper"
