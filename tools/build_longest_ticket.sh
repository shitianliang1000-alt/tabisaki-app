#!/bin/sh
# 最長片道切符のソルバー（solver/longest-ticket/、Rust）を WebAssembly にして、
# packages/core/rail/longest_ticket.wasm に置きます（Issue #431）。
#
#     sh tools/build_longest_ticket.sh
#
# 要るもの: Rust（cargo）と、WebAssembly 向けの部品。
#     rustup target add wasm32-unknown-unknown
#
# ソルバーの中身を変えたら、これを走らせて .wasm も一緒にコミットします
# （Node.js から使う側は、Rust が無くても動くようにしてあります）。
set -eu
cd "$(dirname "$0")/../solver/longest-ticket"
cargo test --release
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/longest_ticket.wasm ../../packages/core/rail/longest_ticket.wasm
ls -l ../../packages/core/rail/longest_ticket.wasm
