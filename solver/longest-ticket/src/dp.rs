//! 本体。辺を1本ずつ決めていく分枝限定法です。
//!
//! ## 考えかた
//!
//! 経路を「どの辺を使うか」の集まりとして見ます。使う辺の集まりが、
//! 決まりに合った経路になるのは、次のときです。
//!
//!   * ひとつながりで、
//!   * 駅ごとの「使う辺の本数」が、次のどれか
//!       - 端が2つ（本数1）、ほかは通り抜け（本数2）……ふつうの経路
//!       - 端が1つ、本数3の駅が1つ、ほかは本数2……終わりが通った駅に着く形（6の字）
//!       - ぜんぶ本数2……一周
//!
//! 辺を決まった順に1本ずつ「使う・使わない（・途中から使う）」に分けていきます
//! （分枝）。ここまでは総当たりと同じで、そのままでは 2^(辺の数) 通りです。
//! 2つのことで、枝を減らします。
//!
//! **1. 同じ形の途中経過をまとめる。** この先に効くのは、「すでに辺が出てきて、
//! まだ残りの辺もある駅」（境目の駅）の様子だけです：それぞれ何本使ったか、
//! どれとどれがつながっているか。ここが同じなら、この先に足せるものも同じなので、
//! **これまでの距離がいちばん長い1つだけ**を残します（支配）。
//!
//! **2. 届かない枝を捨てる。** 残りの辺から足せる距離の上限を先に計算しておき、
//! 「これまでの距離 + 上限」が暫定の経路に届かない途中経過は捨てます（限定）。
//!
//! 境目の駅は、日本の路線網では多くて十数駅です（`order.rs`）。途中経過の数は
//! 辺の数ではなく境目の太さで決まるので、全国でも1秒ほどで最適と証明できます。
//!
//! ## 途中経過の持ちかた
//!
//! 32バイトの並びです。枠ごとに1バイト（境目の駅1つ）:
//!   * 下位2ビット: 使った辺の本数（0〜3）
//!   * ビット2・3: 通り抜けてはいけない2本（forbid）の、どちらを使ったか
//!   * 上位4ビット: つながりの番号（0 = まだどの辺も使っていない）
//! 最後の1バイトは全体のこと:
//!   * 下位2ビット: 端の数（境目を出た駅のうち、本数1のもの + 途中から使った辺）
//!   * ビット2: 本数3の駅がある
//!   * ビット3: 輪を閉じた
//!   * ビット4: 通り抜けの決まりに触れた駅がある（一周のときだけ、そこを
//!     出発駅にすれば許されます）

use crate::order;
use crate::{Clock, Leg, Problem};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

pub const KEYLEN: usize = 32;
const G: usize = KEYLEN - 1;
pub type Key = [u8; KEYLEN];

const N3: u8 = 4;
const CYC: u8 = 8;
const VIOL: u8 = 16;

/// 速いハッシュ（標準のものは安全寄りで遅いので）。
#[derive(Default)]
pub struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut b = [0u8; 8];
            b[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(b)).wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }
}
type Map = HashMap<Key, u32, BuildHasherDefault<Fx>>;

struct Step {
    edge: u32,
    su: usize,
    sv: usize,
    fin_u: bool,
    fin_v: bool,
    forced: bool,
    flag_u: u8,
    flag_v: u8,
    w: i64,
    stub_u: i64,
    stub_v: i64,
}

pub struct Out {
    /// (距離, 使う辺と使いかた[1=全部, 2=u に触れない, 3=v に触れない])
    pub best: Option<(i64, Vec<(u32, u8)>)>,
    pub upper: i64,
    pub width: usize,
    pub layers: usize,
    pub states: u64,
    pub peak: usize,
    pub truncated: bool,
    pub timed_out: bool,
}

enum Applied {
    Dead,
    /// 経路が閉じた（もう辺を足せない）。
    Done(u8),
    Next(Key),
}

#[inline]
fn touch(key: &mut Key, slot: usize, flag: u8, allow_loop: bool) -> bool {
    let b = key[slot];
    let d = b & 3;
    if d == 3 {
        return false;
    }
    if d == 2 {
        if !allow_loop || key[G] & N3 != 0 {
            return false;
        }
        key[G] |= N3;
    }
    key[slot] = (b & !3) | (d + 1) | flag;
    true
}

#[inline]
fn fresh_label(key: &Key) -> Option<u8> {
    let mut used = 0u16;
    for &b in &key[..G] {
        used |= 1 << (b >> 4);
    }
    (1u8..16).find(|&l| used & (1 << l) == 0)
}

#[inline]
fn add_end(key: &mut Key) -> bool {
    if key[G] & 3 == 2 {
        return false;
    }
    key[G] += 1;
    true
}

/// この先、決まりに合う形になりうるか。
#[inline]
fn feasible(g: u8) -> bool {
    let n1 = g & 3;
    if g & (N3 | CYC) != 0 && n1 > 1 {
        return false;
    }
    if g & VIOL != 0 && (n1 != 0 || g & N3 != 0) {
        return false;
    }
    true
}

/// 閉じた経路が、決まりに合う形か。
#[inline]
fn final_ok(g: u8) -> bool {
    let (n1, n3, cyc, viol) = (g & 3, g & N3 != 0, g & CYC != 0, g & VIOL != 0);
    match (n1, n3, cyc) {
        (2, false, false) => !viol,
        (1, true, true) => !viol,
        (0, false, true) => true,
        _ => false,
    }
}

/// 境目を出る駅の始末。閉じたつながりの番号を返します（無ければ 0）。
#[inline]
fn retire(key: &mut Key, slot: usize) -> Result<u8, ()> {
    let b = key[slot];
    key[slot] = 0;
    match b & 3 {
        0 => return Ok(0),
        1 => {
            if !add_end(key) {
                return Err(());
            }
        }
        2 => {
            if b & 12 == 12 {
                if key[G] & VIOL != 0 {
                    return Err(());
                }
                key[G] |= VIOL;
            }
        }
        _ => {}
    }
    let c = b >> 4;
    if key[..G].iter().any(|&x| x >> 4 == c) {
        Ok(0)
    } else {
        Ok(c)
    }
}

/// つながりの番号を、枠の順に 1, 2, 3… と振り直します（同じ形を同じ並びにするため）。
#[inline]
fn canon(key: &mut Key) {
    let mut map = [0u8; 16];
    let mut next = 1u8;
    for b in key[..G].iter_mut() {
        let c = (*b >> 4) as usize;
        if c != 0 {
            if map[c] == 0 {
                map[c] = next;
                next += 1;
            }
            *b = (*b & 15) | (map[c] << 4);
        }
    }
}

fn apply(key: &Key, st: &Step, dec: u8, allow_loop: bool, overflow: &mut bool) -> Applied {
    let mut k = *key;
    match dec {
        0 => {}
        1 => {
            if !touch(&mut k, st.su, st.flag_u, allow_loop) || !touch(&mut k, st.sv, st.flag_v, allow_loop) {
                return Applied::Dead;
            }
            let (cu, cv) = (k[st.su] >> 4, k[st.sv] >> 4);
            if cu == 0 && cv == 0 {
                let Some(l) = fresh_label(&k) else {
                    *overflow = true;
                    return Applied::Dead;
                };
                k[st.su] |= l << 4;
                k[st.sv] |= l << 4;
            } else if cu == 0 {
                k[st.su] |= cv << 4;
            } else if cv == 0 {
                k[st.sv] |= cu << 4;
            } else if cu == cv {
                // 輪が閉じる。輪は1つまで。
                if !allow_loop || k[G] & CYC != 0 {
                    return Applied::Dead;
                }
                k[G] |= CYC;
            } else {
                for b in k[..G].iter_mut() {
                    if *b >> 4 == cv {
                        *b = (*b & 15) | (cu << 4);
                    }
                }
            }
        }
        _ => {
            // 途中から使う: 片方の駅にだけ触れ、端が1つ増える。
            let (slot, flag) = if dec == 2 { (st.sv, st.flag_v) } else { (st.su, st.flag_u) };
            if !touch(&mut k, slot, flag, allow_loop) || !add_end(&mut k) {
                return Applied::Dead;
            }
            if k[slot] >> 4 == 0 {
                let Some(l) = fresh_label(&k) else {
                    *overflow = true;
                    return Applied::Dead;
                };
                k[slot] |= l << 4;
            }
        }
    }
    let mut closed = 0u8;
    if st.fin_u {
        match retire(&mut k, st.su) {
            Err(()) => return Applied::Dead,
            Ok(c) => closed = c,
        }
    }
    if st.fin_v {
        match retire(&mut k, st.sv) {
            Err(()) => return Applied::Dead,
            Ok(c) => {
                if c != 0 {
                    if closed != 0 && closed != c {
                        return Applied::Dead; // 離れた2つが同時に閉じた
                    }
                    closed = c;
                }
            }
        }
    }
    if !feasible(k[G]) {
        return Applied::Dead;
    }
    if closed != 0 {
        // つながりが境目から消えた。ほかにつながりが残っていれば、もう1つにはなれません。
        if k[..G].iter().any(|&b| b >> 4 != 0) {
            return Applied::Dead;
        }
        return Applied::Done(k[G]);
    }
    canon(&mut k);
    Applied::Next(k)
}

/// 残りの辺（step 以降）から足せる距離の上限。
///
/// 使う辺の重みを、両端の駅に半分ずつ配ります。駅が受け取れるのは多くて2本ぶん
/// （本数3の駅が1つだけあり、そこは3本ぶん）なので、駅ごとに重い順の2本を足して
/// 半分にすれば上限になります。途中から使う辺は片方の駅にしか配らないので、
/// そのぶん（多くて2本）を別に足します。
fn bounds(n: usize, steps: &[Step], ends: &[(u32, u32)], allow_loop: bool, max_stubs: i64) -> Vec<i64> {
    let m = steps.len();
    let mut top = vec![[0i64; 3]; n];
    let mut out = vec![0i64; m + 1];
    let mut total = 0i64;
    let mut max_stub = 0i64;
    for i in (0..m).rev() {
        let st = &steps[i];
        let (u, v) = ends[st.edge as usize];
        total += st.w;
        max_stub = max_stub.max(st.stub_u).max(st.stub_v);
        for x in [u as usize, v as usize] {
            let t = &mut top[x];
            let mut w = st.w;
            for slot in t.iter_mut() {
                if w > *slot {
                    std::mem::swap(&mut w, slot);
                }
            }
        }
        let mut sum2 = 0i64;
        let mut third = 0i64;
        for t in &top {
            sum2 += t[0] + t[1];
            third = third.max(t[2]);
        }
        if !allow_loop {
            third = 0;
        }
        let half = (sum2 + third + max_stubs * max_stub + 1) / 2;
        out[i] = half.min(total);
    }
    out
}

/// deadline: この時刻（clock の値、ミリ秒）を過ぎたら打ち切ります。0 は打ち切らない。
pub fn run(p: &Problem, incumbent: i64, clock: &Clock, deadline: u64) -> Result<Out, String> {
    // 出発駅が決まっているときは、仮の駅を1つ足して、出発駅と重み0の辺で結びます
    // （その辺は必ず使う）。こうすると「出発駅が端」という条件が、ふつうの端の
    // 数えかたに入ります。出発駅に戻る一周も「本数3の駅が出発駅」の形になります。
    let mut n = p.n;
    let mut ends: Vec<(u32, u32)> = p.edges.iter().map(|e| (e.u, e.v)).collect();
    let dummy = p.start.map(|s| {
        ends.push((n as u32, s));
        n += 1;
        ends.len() - 1
    });
    // 着く駅も決まっているとき（lns.rs が区間を解き直すとき）は、同じように仮の駅を
    // もう1つ足します。端が2つとも仮の駅になるので、経路は出発駅から着く駅までの道です。
    let dummy_end = p.end.map(|t| {
        ends.push((n as u32, t));
        n += 1;
        ends.len() - 1
    });
    let plan = order::plan(n, &ends);
    if plan.width > G {
        return Err(format!("路線網が込み入りすぎています（境目の駅が{}。上限は{}）", plan.width, G));
    }
    let mut flag = vec![(0u8, 0u8); ends.len()];
    for &(x, a, b) in &p.forbid {
        for (e, bit) in [(a as usize, 4u8), (b as usize, 8u8)] {
            if ends[e].0 == x {
                flag[e].0 |= bit;
            } else {
                flag[e].1 |= bit;
            }
        }
    }
    let steps: Vec<Step> = plan
        .order
        .iter()
        .enumerate()
        .map(|(i, &e)| {
            let real = p.edges.get(e);
            Step {
                edge: e as u32,
                su: plan.slot_u[i] as usize,
                sv: plan.slot_v[i] as usize,
                fin_u: plan.fin_u[i],
                fin_v: plan.fin_v[i],
                forced: Some(e) == dummy || Some(e) == dummy_end,
                flag_u: flag[e].0,
                flag_v: flag[e].1,
                w: real.map(|e| e.w).unwrap_or(0),
                stub_u: real.map(|e| e.stub_u).unwrap_or(0),
                stub_v: real.map(|e| e.stub_v).unwrap_or(0),
            }
        })
        .collect();
    // 出発駅の辺（必ず使う辺）が出てくる前に閉じた経路は、出発駅を通っていません。
    let forced_at = steps.iter().rposition(|s| s.forced).unwrap_or(0);
    let max_stubs = if p.start.is_some() { 1 } else { 2 };
    let rest = bounds(n, &steps, &ends, p.allow_loop, max_stubs);

    let mut out = Out {
        best: None,
        upper: 0,
        width: plan.width,
        layers: steps.len(),
        states: 0,
        peak: 0,
        truncated: false,
        timed_out: false,
    };
    let mut floor = incumbent; // これに届かない枝は捨てる
    let mut best: Option<(i64, usize, u32, u8)> = None; // (距離, 手, 親, 決め方)
    let mut dropped_upper = 0i64;

    let mut keys: Vec<Key> = vec![[0u8; KEYLEN]];
    let mut ws: Vec<i64> = vec![0];
    let mut parents: Vec<Vec<u32>> = Vec::with_capacity(steps.len());
    let mut decs: Vec<Vec<u8>> = Vec::with_capacity(steps.len());
    let mut map: Map = Map::default();
    let mut overflow = false;

    for (i, st) in steps.iter().enumerate() {
        if deadline > 0 && clock.ms() > deadline {
            out.timed_out = true;
            let live = ws.iter().copied().max().unwrap_or(0) + rest[i];
            dropped_upper = dropped_upper.max(live);
            break;
        }
        map.clear();
        let mut nk: Vec<Key> = Vec::with_capacity(keys.len());
        let mut nw: Vec<i64> = Vec::with_capacity(keys.len());
        let mut np: Vec<u32> = Vec::with_capacity(keys.len());
        let mut nd: Vec<u8> = Vec::with_capacity(keys.len());
        let after = rest[i + 1];
        let options: &[(u8, i64)] = &[(0, 0), (1, st.w), (2, st.stub_u), (3, st.stub_v)];
        for (idx, key) in keys.iter().enumerate() {
            let w0 = ws[idx];
            for &(dec, gain) in options {
                if st.forced && dec != 1 {
                    continue;
                }
                if dec >= 2 && gain == 0 {
                    continue;
                }
                let w = w0 + gain;
                if w + after < floor {
                    continue;
                }
                match apply(key, st, dec, p.allow_loop, &mut overflow) {
                    Applied::Dead => {}
                    Applied::Done(g) => {
                        if final_ok(g) && w > 0 && i >= forced_at && best.map(|b| w > b.0).unwrap_or(true) && w >= floor {
                            best = Some((w, i, idx as u32, dec));
                            floor = floor.max(w);
                        }
                    }
                    Applied::Next(k) => match map.entry(k) {
                        std::collections::hash_map::Entry::Occupied(o) => {
                            let j = *o.get() as usize;
                            if w > nw[j] {
                                nw[j] = w;
                                np[j] = idx as u32;
                                nd[j] = dec;
                            }
                        }
                        std::collections::hash_map::Entry::Vacant(v) => {
                            v.insert(nk.len() as u32);
                            nk.push(k);
                            nw.push(w);
                            np.push(idx as u32);
                            nd.push(dec);
                        }
                    },
                }
            }
            if idx & 0xffff == 0xffff && deadline > 0 && clock.ms() > deadline {
                out.timed_out = true;
                // まだ見ていない途中経過のぶんも、上限に入れます。
                let live = ws[idx..].iter().copied().max().unwrap_or(0) + rest[i];
                let made = nw.iter().copied().max().unwrap_or(0) + after;
                dropped_upper = dropped_upper.max(live).max(made);
                break;
            }
        }
        if out.timed_out {
            break;
        }
        // 多すぎるときは、良い順に残します（そのときは「証明なし」です）。
        if nk.len() > p.max_states {
            out.truncated = true;
            let mut idx: Vec<u32> = (0..nk.len() as u32).collect();
            idx.select_nth_unstable_by(p.max_states, |&a, &b| nw[b as usize].cmp(&nw[a as usize]));
            let cut = idx.split_off(p.max_states);
            for &j in &cut {
                dropped_upper = dropped_upper.max(nw[j as usize] + after);
            }
            idx.sort_unstable();
            nk = idx.iter().map(|&j| nk[j as usize]).collect();
            np = idx.iter().map(|&j| np[j as usize]).collect();
            nd = idx.iter().map(|&j| nd[j as usize]).collect();
            nw = idx.iter().map(|&j| nw[j as usize]).collect();
        }
        out.states += nk.len() as u64;
        out.peak = out.peak.max(nk.len());
        parents.push(np);
        decs.push(nd);
        keys = nk;
        ws = nw;
        if keys.is_empty() {
            break;
        }
    }
    if overflow {
        out.truncated = true;
        dropped_upper = dropped_upper.max(rest[0]);
    }
    out.upper = dropped_upper.max(best.map(|b| b.0).unwrap_or(0));

    if let Some((w, step, parent, dec)) = best {
        let mut picks = Vec::new();
        let (mut i, mut idx, mut d) = (step, parent as usize, dec);
        loop {
            let e = steps[i].edge as usize;
            if d != 0 && Some(e) != dummy && Some(e) != dummy_end {
                picks.push((e as u32, d));
            }
            if i == 0 {
                break;
            }
            let prev = i - 1;
            d = decs[prev][idx];
            idx = parents[prev][idx] as usize;
            i = prev;
        }
        picks.reverse();
        out.best = Some((w, picks));
    }
    Ok(out)
}

/// 使う辺の集まりを、通る順に並べます。
pub fn route_of(p: &Problem, picks: &[(u32, u8)]) -> Result<Vec<Leg>, String> {
    if picks.is_empty() {
        return Ok(vec![]);
    }
    let n = p.n;
    // touches[x] = その駅に触れる pick の番号
    let mut touches: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, &(e, d)) in picks.iter().enumerate() {
        let ed = &p.edges[e as usize];
        if d != 2 {
            touches[ed.u as usize].push(k);
        }
        if d != 3 {
            touches[ed.v as usize].push(k);
        }
    }
    let forbidden = |x: u32, a: u32, b: u32| {
        p.forbid.iter().any(|&(fx, fa, fb)| fx == x && ((fa == a && fb == b) || (fa == b && fb == a)))
    };
    let mut used = vec![false; picks.len()];
    let mut visited = vec![false; n];
    let mut route: Vec<Leg> = Vec::with_capacity(picks.len());

    // 出発点を決めます。
    let mut head: u32;
    let mut prev: Option<u32> = None;
    let stub = picks.iter().position(|&(_, d)| d >= 2);
    let leaf = (0..n).find(|&x| touches[x].len() == 1);
    if let Some(s) = p.start {
        head = s;
    } else if let Some(k) = stub {
        // 途中から使う辺があれば、そこが出発（6の字なら端は1つで、それが出発）。
        let (e, d) = picks[k];
        let ed = &p.edges[e as usize];
        let (from, to) = if d == 2 { (ed.u, ed.v) } else { (ed.v, ed.u) };
        route.push(Leg { edge: e, from, to, mode: 1 });
        used[k] = true;
        head = to;
        prev = Some(e);
    } else if let Some(x) = leaf {
        head = x as u32;
    } else {
        // 一周。通り抜けの決まりに触れる駅があれば、そこを出発駅にします。
        let bad = (0..n).find(|&x| {
            touches[x].len() == 2 && forbidden(x as u32, picks[touches[x][0]].0, picks[touches[x][1]].0)
        });
        head = bad.or_else(|| (0..n).find(|&x| !touches[x].is_empty())).ok_or("経路が空です")? as u32;
    }
    visited[head as usize] = true;

    loop {
        let cands: Vec<usize> = touches[head as usize].iter().copied().filter(|&k| !used[k]).collect();
        if cands.is_empty() {
            break;
        }
        let ok = |k: usize| prev.map(|pe| !forbidden(head, pe, picks[k].0)).unwrap_or(true);
        // 途中で終わる辺は最後に取ります（ほかに進める辺があるうちは進む）。
        let k = cands
            .iter()
            .copied()
            .filter(|&k| ok(k))
            .min_by_key(|&k| picks[k].1 >= 2)
            .ok_or("通り抜けの決まりに合う並べかたがありません")?;
        used[k] = true;
        let (e, d) = picks[k];
        let ed = &p.edges[e as usize];
        let to = if ed.u == head { ed.v } else { ed.u };
        if d >= 2 {
            route.push(Leg { edge: e, from: head, to, mode: 2 });
            break;
        }
        route.push(Leg { edge: e, from: head, to, mode: 0 });
        prev = Some(e);
        if visited[to as usize] {
            break;
        }
        visited[to as usize] = true;
        head = to;
    }
    if used.iter().any(|&u| !u) {
        return Err("使う辺を1本の経路に並べられませんでした".into());
    }
    Ok(route)
}
