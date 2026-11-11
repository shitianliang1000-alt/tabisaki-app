//! WebAssembly から呼ぶ口。
//!
//! JS とは、文字の並びだけをやり取りします。
//!   1. `lt_alloc(長さ)` で場所をもらい、入力の文（`parse` が読む形）を書く
//!   2. `lt_solve(場所, 長さ)` を呼ぶ。返るのは結果の場所で、先頭4バイトが長さ、
//!      続きが JSON（失敗したときは `{"error":"…"}`）
//!   3. `lt_free(場所, 長さ)` で返す
//! 時計は JS から借ります（`env.now_ms`）。

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn now_ms() -> f64;
}

#[cfg(target_arch = "wasm32")]
pub fn now() -> f64 {
    unsafe { now_ms() }
}

#[no_mangle]
pub extern "C" fn lt_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` は `lt_alloc(len)` か `lt_solve` が返した場所であること。
#[no_mangle]
pub unsafe extern "C" fn lt_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// # Safety
/// `ptr` から `len` バイトが読めること。
#[no_mangle]
pub unsafe extern "C" fn lt_solve(ptr: *const u8, len: usize) -> *mut u8 {
    let text = String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).into_owned();
    let json = match crate::parse(&text).and_then(|p| crate::solve(&p)) {
        Ok(s) => crate::to_json(&s),
        Err(e) => format!("{{\"error\":\"{}\"}}", e.replace('\\', "\\\\").replace('"', "\\\"")),
    };
    let bytes = json.into_bytes();
    let total = bytes.len() + 4;
    let out = lt_alloc(total);
    std::ptr::copy_nonoverlapping((bytes.len() as u32).to_le_bytes().as_ptr(), out, 4);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out.add(4), bytes.len());
    out
}
